// Single-use links that move a member's sign-in email to a new address. Only the token's hash is
// stored, and nothing changes until the new address opens the link.

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { enqueueNotification } from '../notifications/store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const emailChangeLifetimeMs = 24 * 60 * 60 * 1000;
const invalid = () => new AppError(400, 'EMAIL_CHANGE_INVALID',
  'This link is invalid or has expired. Your email hasn’t changed. Request a new link from your profile.');

export interface PendingEmail { email: string; expiresAt: string }

/** Another account already signs in with `email` (case-insensitive). */
export async function emailTaken(db: Database, email: string, userId: number) {
  const { rows } = await db.query('SELECT 1 FROM "user" WHERE lower(email)=lower($1) AND userid<>$2', [email, userId]);
  return rows.length > 0;
}

/** The member's pending change, if any, with when it was last sent. Caller holds the account lock. */
export async function pendingEmailChange(db: Database, userId: number) {
  const { rows } = await db.query<{ email: string; createdAt: Date }>(
    'SELECT new_email AS email, created_at AS "createdAt" FROM app_email_change WHERE userid=$1', [userId]);
  return rows[0] ?? null;
}

/**
 * Replace any earlier pending change and queue two emails: the link, to the new address, and a
 * heads-up to the current one. Caller owns the transaction and the account row lock.
 */
export async function issueEmailChange(db: Database, userId: number, currentEmail: string, newEmail: string, origin: string): Promise<PendingEmail> {
  const token = randomBytes(32).toString('base64url');
  const digest = hash(token);
  const expiresAt = new Date(Date.now() + emailChangeLifetimeMs);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='email_change_confirmation' AND status='pending'`, [userId]);
  await db.query(`INSERT INTO app_email_change(userid,new_email,token_hash,expires_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(userid) DO UPDATE SET new_email=EXCLUDED.new_email,token_hash=EXCLUDED.token_hash,
      expires_at=EXCLUDED.expires_at,created_at=NOW()`, [userId, newEmail, digest, expiresAt]);
  const confirmationUrl = new URL('/confirm-email-change', origin);
  confirmationUrl.hash = token;
  // Both go to fixed addresses: the link to the new one, the heads-up to the one in use now.
  await enqueueNotification(db, { userId, kind: 'email_change_confirmation', dedupeKey: `email-change:${digest}`,
    payload: { confirmationUrl: confirmationUrl.href, expiresAt: expiresAt.toISOString(), changeHash: digest, recipientEmail: newEmail } });
  await enqueueNotification(db, { userId, kind: 'email_change_requested', dedupeKey: `email-change-notice:${digest}`,
    payload: { newEmail, recipientEmail: currentEmail } });
  return { email: newEmail, expiresAt: expiresAt.toISOString() };
}

/** Drop the pending change and its unsent link. Caller owns the transaction. */
export async function cancelEmailChange(db: Database, userId: number): Promise<boolean> {
  const removed = await db.query('DELETE FROM app_email_change WHERE userid=$1', [userId]);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='email_change_confirmation' AND status='pending'`, [userId]);
  return (removed.rowCount ?? 0) > 0;
}

/**
 * Apply the change a link was sent for. Locks the account first, like every other credential
 * change, so a password reset or a second link can't interleave.
 */
export async function consumeEmailChange(db: Database, token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const digest = hash(token);
  const account = (await db.query<{ userid: number; email: string; status: string }>(
    `SELECT u.userid, u.email, u.status FROM "user" u JOIN app_email_change c USING(userid)
     WHERE c.token_hash=$1 FOR UPDATE OF u`, [digest])).rows[0];
  if (!account || account.status !== 'active') throw invalid();
  const consumed = (await db.query<{ email: string }>(`DELETE FROM app_email_change
    WHERE userid=$1 AND token_hash=$2 AND expires_at>NOW() RETURNING new_email AS email`, [account.userid, digest])).rows[0];
  if (!consumed) throw invalid();
  if (await emailTaken(db, consumed.email, account.userid))
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Another account now signs in with that email, so yours hasn’t changed.');
  await db.query('UPDATE "user" SET email=$2,email_confirmed=true,revision=revision+1 WHERE userid=$1', [account.userid, consumed.email]);
  // The old inbox no longer controls the account: its reset links stop working.
  await db.query('DELETE FROM app_password_reset WHERE userid=$1', [account.userid]);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind IN ('password_reset','email_change_confirmation') AND status='pending'`, [account.userid]);
  return { userId: account.userid, previousEmail: account.email, email: consumed.email };
}
