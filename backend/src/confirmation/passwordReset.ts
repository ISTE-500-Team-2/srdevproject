import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { hashPassword } from '../passwords.js';
import { enqueueNotification } from '../notifications/store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const resetLifetimeMs = 30 * 60 * 1000;
const invalid = () => new AppError(400, 'RESET_INVALID', 'This reset link is invalid or expired. Request a new one.');
function digest(token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  return hash(token);
}

/** Caller owns transaction and account row lock. Never return tokens to the requester. */
export async function issuePasswordReset(db: Database, userId: number, origin: string) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + resetLifetimeMs);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='password_reset' AND status='pending'`, [userId]);
  await db.query(`INSERT INTO app_password_reset(userid,token_hash,expires_at) VALUES($1,$2,$3)
    ON CONFLICT(userid) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_at=NOW()`,
    [userId, tokenHash, expiresAt]);
  const resetUrl = new URL('/reset-password', origin);
  resetUrl.hash = token;
  await enqueueNotification(db, { userId, kind: 'password_reset', dedupeKey: `reset:${tokenHash}`,
    payload: { resetUrl: resetUrl.href, expiresAt: expiresAt.toISOString(), resetHash: tokenHash } });
}

export async function checkPasswordReset(db: Database, token: unknown) {
  const row = await db.query(`SELECT 1 FROM app_password_reset r JOIN "user" u USING(userid)
    WHERE r.token_hash=$1 AND r.expires_at>NOW() AND u.status='active'`, [digest(token)]);
  if (!row.rows.length) throw invalid();
}

/** Caller owns the transaction; account-first locking also serializes session refreshes. */
export async function consumePasswordReset(db: Database, token: unknown, password: string) {
  const tokenHash = digest(token);
  const account = (await db.query(`SELECT u.userid,u.status FROM "user" u JOIN app_password_reset r USING(userid)
    WHERE r.token_hash=$1 FOR UPDATE OF u`, [tokenHash])).rows[0];
  if (!account || account.status !== 'active') throw invalid();
  const consumed = await db.query(`DELETE FROM app_password_reset
    WHERE userid=$1 AND token_hash=$2 AND expires_at>NOW() RETURNING userid`, [account.userid, tokenHash]);
  if (!consumed.rows.length) throw invalid();
  // A hashing/validation failure rolls back token consumption and every other change.
  const encoded = await hashPassword(password);
  await db.query('UPDATE "user" SET password=$2,email_confirmed=true WHERE userid=$1', [account.userid, encoded]);
  await db.query('DELETE FROM app_session WHERE userid=$1', [account.userid]);
  await db.query('UPDATE app_refresh_family SET revoked=true WHERE userid=$1', [account.userid]);
  await db.query('DELETE FROM app_email_confirmation WHERE userid=$1', [account.userid]);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind IN ('password_reset','account_confirmation') AND status='pending'`, [account.userid]);
  await enqueueNotification(db, { userId: account.userid, kind: 'password_changed',
    dedupeKey: `password-changed:${tokenHash}`, payload: {} });
}
