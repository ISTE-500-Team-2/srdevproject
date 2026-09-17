import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { expirationSourceCurrent } from './scheduler.js';

export interface PendingNotification {
  id:number;userId:number;kind:string;dedupeKey:string;payload:Record<string,unknown>;
  email:string;firstName:string;timeZone:string;attempts:number;dueAt:Date;deadlineAt:Date;
}
/** Only explicit provider rejection known not to have accepted mail may retry. */
export class NotificationSendError extends Error {
  constructor(message:string,public options:{retryable:boolean;ambiguous?:boolean;retryAfterMs?:number}) {super(message);}
}
export async function runNotificationBatch(pool:Pool,send:(notification:PendingNotification)=>Promise<{messageId:string}>,options:{batchSize?:number;maxAttempts?:number;now?:Date}={}) {
  const result={accepted:0,suppressed:0,failed:0,uncertain:0,retried:0,obsolete:0};
  const batchSize=Math.min(100,Math.max(1,options.batchSize??20));
  const maxAttempts=Math.min(10,Math.max(1,options.maxAttempts??5));
  const clock=()=>options.now??new Date();
  // A process may have died after provider acceptance. Do not resend lease-expired
  // work automatically: at-least-once HTTP retries could duplicate user mail.
  await pool.query(`UPDATE app_notification_outbox SET status='uncertain',last_error='lease_expired_acceptance_unknown',lease_until=NULL,updated_at=NOW()
    WHERE status='sending' AND lease_until<$1`,[clock()]);
  for(let i=0;i<batchSize;i++) {
    const row=await transaction(pool,async db=>{
      const selected=await db.query<PendingNotification>(`SELECT o.id,o.userid AS "userId",o.kind,o.dedupe_key AS "dedupeKey",o.payload,
        o.attempts,o.due_at AS "dueAt",o.deadline_at AS "deadlineAt",u.email,u.firstname AS "firstName",
        COALESCE(p.time_zone,'America/New_York') AS "timeZone"
        FROM app_notification_outbox o JOIN "user" u ON u.userid=o.userid
        LEFT JOIN app_notification_preferences p ON p.userid=o.userid
        WHERE o.status='pending' AND o.due_at<=$1 ORDER BY o.due_at,o.id
        LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,[clock()]);
      const item=selected.rows[0];
      if(!item)return null;
      await db.query(`UPDATE app_notification_outbox SET status='sending',attempts=attempts+1,lease_until=$2::timestamptz+INTERVAL '2 minutes',updated_at=NOW() WHERE id=$1`,[item.id,clock()]);
      item.attempts++;
      return item;
    });
    if(!row)break;
    const finish=async(status:string,error?:string)=>{
      await pool.query(`UPDATE app_notification_outbox SET status=$2,lease_until=NULL,last_error=$3,counts_for_sla=CASE WHEN $2 IN ('suppressed','obsolete') AND deadline_at>=$4 THEN false ELSE counts_for_sla END,updated_at=NOW() WHERE id=$1 AND status='sending'`,[row.id,status,error??null,clock()]);
    };
    try {
      const allowed=await pool.query(`SELECT 1 FROM "user" u LEFT JOIN app_notification_preferences p USING(userid)
        WHERE u.userid=$1 AND u.status='active' AND COALESCE(p.enabled,true)`,[row.userId]);
      if(!allowed.rows.length) {await finish('suppressed');result.suppressed++;continue;}
      if(!await expirationSourceCurrent(pool,row.userId,row.payload,clock())) {await finish('obsolete');result.obsolete++;continue;}
      if(typeof row.payload.expiresAt==='string' && new Date(row.payload.expiresAt)<=clock()) {
        await finish('failed','expired_before_dispatch');result.failed++;continue;
      }
      const response=await send(row);
      if(!response.messageId)throw new NotificationSendError('Provider response missing message id',{retryable:false,ambiguous:true});
      await pool.query(`UPDATE app_notification_outbox SET status='accepted',accepted_at=$2,provider_message_id=$3,lease_until=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('sending','uncertain')`,[row.id,clock(),response.messageId]);
      result.accepted++;
    }catch(error) {
      // Never persist raw provider responses, URLs or message contents.
      const known=error instanceof NotificationSendError;
      if(known && !error.options.ambiguous && error.options.retryable && row.attempts<maxAttempts) {
        const delay=Math.min(86400,Math.max(30*2**(row.attempts-1),(error.options.retryAfterMs??0)/1000));
        await pool.query(`UPDATE app_notification_outbox SET status='pending',due_at=$2::timestamptz+($3*INTERVAL '1 second'),lease_until=NULL,last_error='provider_rejected_retryable',updated_at=NOW() WHERE id=$1 AND status='sending'`,[row.id,clock(),delay]);
        result.retried++;
      } else if(known && !error.options.ambiguous) {await finish('failed','provider_rejected');result.failed++;}
      else {await finish('uncertain','provider_acceptance_unknown');result.uncertain++;}
    }
  }
  return result;
}
