import type { Database } from '../db.js';
import { enqueueNotification } from './store.js';
import { reminderDates } from './reminderTiming.js';

export { reminderDates };

export const EXPIRATION_LOOKAHEAD_DAYS=30;
interface ExpirationSource {userId:number; sourceType:'certification'|'waiver'|'membership';sourceId:number;expiresAt:Date;grantedAt:Date|null;name:string;timeZone:string}
export async function scheduleExpirationNotifications(db:Database,now=new Date()):Promise<number> {
  const {rows}=await db.query<ExpirationSource>(`WITH expirations AS (
    SELECT uc.userid, 'certification'::text AS source_type,uc.usercertid AS source_id,
      LEAST(uc.renewaldate,c.enddate) AT TIME ZONE 'UTC' AS expires_at,COALESCE(uc.approved_at,uc.trained_at) AS granted_at,c.name
    FROM user_certifications uc JOIN certifications c USING(certid) WHERE uc.status='active'
    UNION ALL
    SELECT uw.userid,'waiver',uw.userwaiverid,uw.expires_at,uw.signdate AT TIME ZONE 'UTC',w.name
    FROM user_waiver uw JOIN waiver w USING(waiverid) WHERE uw.approval=true AND w.isactive=true
    UNION ALL
    SELECT um.userid,'membership',um.membershipid,um.end_date AT TIME ZONE 'UTC',um.startdate AT TIME ZONE 'UTC','Membership'
    FROM user_membership um WHERE um.status='active'
  ) SELECT e.userid AS "userId",source_type AS "sourceType",source_id AS "sourceId",expires_at AS "expiresAt",granted_at AS "grantedAt",name,
    COALESCE(p.time_zone,'America/New_York') AS "timeZone"
    FROM expirations e JOIN "user" u USING(userid) LEFT JOIN app_notification_preferences p USING(userid)
    WHERE expires_at>$1 AND expires_at<=$1::timestamptz+INTERVAL '${EXPIRATION_LOOKAHEAD_DAYS} days' AND u.status='active'`,[now]);
  for(const row of rows) {
    const expiry=new Date(row.expiresAt);
    const dates=reminderDates(expiry,row.timeZone);
    await enqueueNotification(db,{userId:row.userId,kind:`${row.sourceType}_expiring` as const,
      dedupeKey:`${row.sourceType}-expiring:${row.sourceId}:${expiry.toISOString()}`,
      // Granted with under a week left: a week's notice was impossible, so send
      // it now but do not record it as a missed deadline.
      ...dates,countsForSla:!row.grantedAt||new Date(row.grantedAt)<dates.deadlineAt,payload:{sourceType:row.sourceType,sourceId:row.sourceId,expiresAt:expiry.toISOString(),name:row.name}});
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
