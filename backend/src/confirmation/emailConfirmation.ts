import { randomBytes, createHash } from 'node:crypto';
import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { enqueueNotification } from '../notifications/store.js';
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export const confirmationLifetimeMs = 24 * 60 * 60 * 1000;
/** Caller owns transaction and account row lock. Never return token to the registration client. */
export async function issueEmailConfirmation(db:Database,userId:number,origin:string) {
  const token=randomBytes(32).toString('base64url');
  const digest=hash(token);
  const expiresAt=new Date(Date.now()+confirmationLifetimeMs);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='account_confirmation' AND status='pending'`,[userId]);
  await db.query(`INSERT INTO app_email_confirmation(userid,token_hash,expires_at) VALUES($1,$2,$3)
    ON CONFLICT(userid) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_at=NOW()`,[userId,digest,expiresAt]);
  const confirmationUrl=new URL('/confirm-email',origin); confirmationUrl.hash=token;
  await enqueueNotification(db,{userId,kind:'account_confirmation',dedupeKey:`confirm:${digest}`,payload:{confirmationUrl:confirmationUrl.href,expiresAt:expiresAt.toISOString(),confirmationHash:digest}});
}
export async function consumeEmailConfirmation(db:Database,token:unknown):Promise<number> {
  if(typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  // Consistent account-first locking serializes resend/change/confirmation races.
  const row=(await db.query(`SELECT u.userid,u.email_confirmed,u.status FROM "user" u JOIN app_email_confirmation c USING(userid)
    WHERE c.token_hash=$1 FOR UPDATE OF u`,[hash(token)])).rows[0];
  if(!row || row.email_confirmed || row.status!=='active') throw invalid();
  const consumed=await db.query(`DELETE FROM app_email_confirmation WHERE userid=$1 AND token_hash=$2 AND expires_at>NOW() RETURNING userid`,[row.userid,hash(token)]);
  if(!consumed.rows.length)throw invalid();
  await db.query('UPDATE "user" SET email_confirmed=true WHERE userid=$1',[row.userid]);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW() WHERE userid=$1 AND kind='account_confirmation' AND status='pending'`,[row.userid]);
  await enqueueNotification(db,{userId:row.userid,kind:'account_created',dedupeKey:`account-created:${row.userid}`,payload:{}});
  return row.userid;
}
function invalid(){return new AppError(400,'CONFIRMATION_INVALID','This confirmation link is invalid or expired. Request a new email.');}
