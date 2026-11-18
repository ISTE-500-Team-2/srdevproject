// Single-use links that move a member's sign-in email to a new address. Only the token's hash is
// stored, and nothing changes until the new address opens the link.

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { enqueueNotification } from '../notifications/store.js';
import { noticeAddressInUse } from './pendingRegistration.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const emailChangeLifetimeMs = 24 * 60 * 60 * 1000;
const invalid = () => new AppError(400, 'EMAIL_CHANGE_INVALID',
  'This link is invalid or has expired. Your email hasn’t changed. Request a new link from your profile.');

export interface PendingEmail { email: string; expiresAt: string }

/** The other account that already signs in with `email` (case-insensitive), if there is one. */
async function emailOwner(db: Database, email: string, userId: number) {
  const { rows } = await db.query<{ userid: number }>('SELECT userid FROM "user" WHERE lower(email)=lower($1) AND userid<>$2', [email, userId]);
  return rows[0]?.userid;
}

/** The member's unexpired pending change, with when its link was last sent. Caller holds the account lock. */
export async function pendingEmailChange(db: Database, userId: number) {
  const { rows } = await db.query<{ email: string; createdAt: Date }>(
    'SELECT new_email AS email, created_at AS "createdAt" FROM app_email_change WHERE userid=$1 AND expires_at>NOW()', [userId]);
  return rows[0] ?? null;
}

/** An unsent link must not go out once its change is replaced, cancelled or applied. */
async function retireLinkMail(db: Database, userId: number) {
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='email_change_confirmation' AND status='pending'`, [userId]);
}

/**
 * Replace any earlier pending change and queue the link to the new address. `notifyCurrent` also
 * sends the current address a heads-up: once per address asked for, not on every resend.
 * An address another account already uses is handled the same way, so the answer never reveals
 * who is a member, except that no link goes to it: its owner is told someone tried to use it.
 * Caller owns the transaction and the account row lock.
 */
export async function issueEmailChange(db: Database, userId: number, currentEmail: string, newEmail: string, origin: string,
  { notifyCurrent }: { notifyCurrent: boolean }): Promise<PendingEmail> {
  const token = randomBytes(32).toString('base64url');
  const digest = hash(token);
  const expiresAt = new Date(Date.now() + emailChangeLifetimeMs);
  await retireLinkMail(db, userId);
  await db.query(`INSERT INTO app_email_change(userid,new_email,token_hash,expires_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(userid) DO UPDATE SET new_email=EXCLUDED.new_email,token_hash=EXCLUDED.token_hash,
      expires_at=EXCLUDED.expires_at,created_at=NOW()`, [userId, newEmail, digest, expiresAt]);
  const confirmationUrl = new URL('/confirm-email-change', origin);
  confirmationUrl.hash = token;
  // Both go to fixed addresses: the link to the new one, the heads-up to the one in use now. An
  // address that is already taken gets its owner's notice instead of the link.
  const owner = await emailOwner(db, newEmail, userId);
  if (owner !== undefined) await noticeAddressInUse(db, owner);
  else await enqueueNotification(db, { userId, kind: 'email_change_confirmation', dedupeKey: `email-change:${digest}`,
    payload: { confirmationUrl: confirmationUrl.href, expiresAt: expiresAt.toISOString(), changeHash: digest, recipientEmail: newEmail } });
  if (notifyCurrent)
    await enqueueNotification(db, { userId, kind: 'email_change_requested', dedupeKey: `email-change-notice:${digest}`,
      payload: { newEmail, recipientEmail: currentEmail } });
  return { email: newEmail, expiresAt: expiresAt.toISOString() };
}

/**
 * Drop the pending change and its unsent link. Returns the address that was still waiting, or null
 * when there was none (or only an expired one), so callers can log what they cancelled.
 * Caller owns the transaction.
 */
export async function cancelEmailChange(db: Database, userId: number): Promise<string | null> {
  const removed = (await db.query<{ email: string; live: boolean }>(
    'DELETE FROM app_email_change WHERE userid=$1 RETURNING new_email AS email, expires_at>NOW() AS live', [userId])).rows[0];
  await retireLinkMail(db, userId);
  return removed?.live ? removed.email : null;
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
  // Signed out, so nobody was known when the transaction began: the database's own change
  // records for what follows name the member whose link this is.
  await db.query("SELECT set_config('app.actor_id',$1,true)", [String(account.userid)]);
  const consumed = (await db.query<{ email: string }>(`DELETE FROM app_email_change
    WHERE userid=$1 AND token_hash=$2 AND expires_at>NOW() RETURNING new_email AS email`, [account.userid, digest])).rows[0];
  if (!consumed) throw invalid();
  if (await emailOwner(db, consumed.email, account.userid) !== undefined)
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Another account now signs in with that email, so yours hasn’t changed.');
  await db.query('UPDATE "user" SET email=$2,email_confirmed=true,revision=revision+1 WHERE userid=$1', [account.userid, consumed.email]);
  // The old inbox no longer controls the account: its reset links stop working.
  await db.query('DELETE FROM app_password_reset WHERE userid=$1', [account.userid]);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE userid=$1 AND kind='password_reset' AND status='pending'`, [account.userid]);
  await retireLinkMail(db, account.userid);
  return { userId: account.userid, previousEmail: account.email, email: consumed.email };
}
