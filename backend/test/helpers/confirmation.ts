import type { Pool } from 'pg';
/** Test-only inbox: reads the isolated DB outbox, never exposed as an API. */
export async function confirmationToken(pool:Pool,email:string):Promise<string> {
  const row=(await pool.query(`SELECT o.payload FROM app_notification_outbox o JOIN "user" u USING(userid)
    WHERE u.email=$1 AND o.kind='account_confirmation' ORDER BY o.id DESC LIMIT 1`,[email])).rows[0];
  if(!row)throw new Error('Expected confirmation notification');
  return new URL(row.payload.confirmationUrl).hash.slice(1);
}
