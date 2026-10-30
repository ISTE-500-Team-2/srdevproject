import type { Pool } from 'pg';
/** Test-only inbox supports staged sign-ups and older account-bound confirmation links. */
export async function confirmationToken(pool:Pool,email:string):Promise<string> {
  const row=(await pool.query(`SELECT o.payload FROM app_notification_outbox o LEFT JOIN "user" u USING(userid)
    LEFT JOIN app_pending_registration r ON r.id=o.registration_id
    WHERE COALESCE(u.email,r.email)=$1 AND o.kind='account_confirmation' ORDER BY o.id DESC LIMIT 1`,[email])).rows[0];
  if(!row)throw new Error('Expected confirmation notification');
  return new URL(row.payload.confirmationUrl).hash.slice(1);
}
