import type { Database } from '../db.js';
import { enqueueNotification, validTimeZone } from './store.js';

const DAY=86_400_000;
function dateParts(date:Date,timeZone:string) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(name:string)=>Number(parts.find(p=>p.type===name)!.value);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute'),second:get('second')};
}
/** Send at 09:00 eight local calendar days before expiry, leaving retry headroom
 * before the strict seven-elapsed-day deadline. Handles DST without fixed offsets. */
export function reminderDates(expiry:Date,timeZone:string):{dueAt:Date;deadlineAt:Date} {
  if (!Number.isFinite(expiry.getTime()) || !validTimeZone(timeZone)) throw new Error('Invalid expiry/time zone');
  const p=dateParts(expiry,timeZone);
  const target=new Date(Date.UTC(p.year,p.month-1,p.day-8,9));
  const desired=target.getTime();
  let actual=desired;
  for(let i=0;i<5;i++) {
    const local=dateParts(new Date(actual),timeZone);
    const represented=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute,local.second);
    const correction=desired-represented;
    actual+=correction;
    if(correction===0)break;
  }
  const deadlineAt=new Date(expiry.getTime()-7*DAY);
  return {dueAt:new Date(Math.min(actual,deadlineAt.getTime()-3_600_000)),deadlineAt};
}
interface ExpirationSource {userId:number; sourceType:string;sourceId:number;expiresAt:Date;name:string;timeZone:string}
export async function scheduleExpirationNotifications(db:Database,now=new Date()):Promise<number> {
  const {rows}=await db.query<ExpirationSource>(`WITH expirations AS (
    SELECT uc.userid, 'certification'::text AS source_type,uc.usercertid AS source_id,
      LEAST(uc.renewaldate,c.enddate) AT TIME ZONE 'UTC' AS expires_at,c.name
    FROM user_certifications uc JOIN certifications c USING(certid) WHERE uc.status='active'
    UNION ALL
    SELECT uw.userid,'waiver',uw.userwaiverid,uw.expires_at,w.name
    FROM user_waiver uw JOIN waiver w USING(waiverid) WHERE uw.approval=true AND w.isactive=true
    UNION ALL
    SELECT um.userid,'membership',um.membershipid,um.end_date AT TIME ZONE 'UTC','Membership'
    FROM user_membership um WHERE um.status='active'
  ) SELECT e.userid AS "userId",source_type AS "sourceType",source_id AS "sourceId",expires_at AS "expiresAt",name,
    COALESCE(p.time_zone,'America/New_York') AS "timeZone"
    FROM expirations e JOIN "user" u USING(userid) LEFT JOIN app_notification_preferences p USING(userid)
    WHERE expires_at>$1 AND expires_at<=$1::timestamptz+INTERVAL '30 days' AND u.status='active'`,[now]);
  for(const row of rows) {
    const expiry=new Date(row.expiresAt);
    const dates=reminderDates(expiry,row.timeZone);
    await enqueueNotification(db,{userId:row.userId,kind:`${row.sourceType}_expiring`,
      dedupeKey:`${row.sourceType}-expiring:${row.sourceId}:${expiry.toISOString()}`,
      ...dates,payload:{sourceType:row.sourceType,sourceId:row.sourceId,expiresAt:expiry.toISOString(),name:row.name}});
  }
  return rows.length;
}
/** Recheck source immediately before dispatch: renewal/revocation cancels stale notices. */
export async function expirationSourceCurrent(db:Database,userId:number,payload:Record<string,unknown>,now:Date):Promise<boolean> {
  if(!payload.sourceType)return true;
  if(!Number.isSafeInteger(payload.sourceId) || typeof payload.expiresAt!=='string')return false;
  const expiry=new Date(payload.expiresAt);
  if(!Number.isFinite(expiry.getTime()))return false;
  const values=[userId,payload.sourceId,expiry];
  const sql=payload.sourceType==='certification' ? `SELECT 1 FROM user_certifications uc JOIN certifications c USING(certid)
    WHERE uc.userid=$1 AND uc.usercertid=$2 AND uc.status='active' AND date_trunc('milliseconds',LEAST(uc.renewaldate,c.enddate) AT TIME ZONE 'UTC')=$3`
    :payload.sourceType==='waiver' ? `SELECT 1 FROM user_waiver uw JOIN waiver w USING(waiverid)
    WHERE uw.userid=$1 AND uw.userwaiverid=$2 AND uw.approval=true AND w.isactive=true AND date_trunc('milliseconds',uw.expires_at)=$3`
    :payload.sourceType==='membership' ? `SELECT 1 FROM user_membership WHERE userid=$1 AND membershipid=$2 AND status='active' AND date_trunc('milliseconds',end_date AT TIME ZONE 'UTC')=$3`
    :null;
  return sql ? (await db.query(sql,values)).rows.length>0 : false;
}
