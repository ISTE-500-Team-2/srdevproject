// Keeps unconfirmed sign-ups outside the member roster; consuming a valid confirmation creates the
// actual account.

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { UserModel } from '../models/UserModel.js';
import { verifyPassword } from '../passwords.js';
import { enqueueNotification, updateNotificationPreferences } from '../notifications/store.js';

interface RegistrationInput {
  firstName: string; lastName: string; email: string; phone: string;
  dob: string; password: string; timeZone: string;
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Expired requests and their queued mail are removed without ever creating member records. */
/**
 * Remove expired staged sign-ups so unconfirmed personal data does not remain in the pending roster
 * indefinitely.
 */
export async function pruneRegistrations(db: Database) {
  await db.query('DELETE FROM app_pending_registration WHERE expires_at<=NOW()');
}

/** Only the latest token can complete a request; resends invalidate earlier queued links. */
export async function sendRegistrationConfirmation(db: Database, id: number, origin: string) {
  const token = randomBytes(32).toString('base64url');
  const hash = digest(token);
  const expires = new Date(Date.now() + 24 * 60 * 60_000);
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE registration_id=$1 AND status='pending'`, [id]);
  await db.query('UPDATE app_pending_registration SET token_hash=$2,expires_at=$3,sent_at=NOW() WHERE id=$1', [id, hash, expires]);
  const url = new URL('/confirm-email', origin); url.hash = token;
  await db.query(`INSERT INTO app_notification_outbox(registration_id,kind,dedupe_key,payload,deadline_at,counts_for_sla)
    VALUES($1,'account_confirmation',$2,$3::jsonb,NOW()+INTERVAL '5 minutes',false)`,
    [id, `registration:${hash}`, JSON.stringify({ confirmationUrl: url.href, confirmationHash: hash, expiresAt: expires.toISOString() })]);
}

/**
 * Stage a sign-up and email its confirmation link. Every attempt looks the same to the caller, so
 * sign-up never reveals whether an address belongs to a member: an existing account's owner gets a
 * notice instead (at most one an hour). A newer sign-up for a still-pending address replaces its
 * details, password and link, so a stranger who staged that address first can't have their
 * password become the account its owner later confirms.
 */
export async function stageRegistration(db: Database, input: RegistrationInput, origin: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [input.email]);
  const existing = (await db.query<{ userid: number }>('SELECT userid FROM "user" WHERE lower(email)=$1', [input.email])).rows[0];
  if (existing) {
    await enqueueNotification(db, { userId: existing.userid, kind: 'account_exists',
      dedupeKey: `account-exists:${existing.userid}:${Math.floor(Date.now() / 3_600_000)}`, payload: {} });
    return;
  }
  const row = (await db.query<{ id: number }>(`INSERT INTO app_pending_registration(email,first_name,last_name,phone,dob,password_hash,time_zone)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
    phone=EXCLUDED.phone,dob=EXCLUDED.dob,password_hash=EXCLUDED.password_hash,time_zone=EXCLUDED.time_zone RETURNING id`,
    [input.email,input.firstName,input.lastName,input.phone,input.dob,input.password,input.timeZone])).rows[0]!;
  // A fresh token: links sent for an earlier sign-up stop working.
  await sendRegistrationConfirmation(db, row.id, origin);
}

/** Possession of a live, single-use inbox token is required before allocating a user, role or session. */
/** Consume a valid staged confirmation and create the member once; return null for an unusable token. */
export async function consumeRegistration(db: Database, token: unknown): Promise<number | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  // Take the email lock before the row lock, matching registration and resend lock order.
  const found = (await db.query('SELECT email FROM app_pending_registration WHERE token_hash=$1', [digest(token)])).rows[0];
  if (!found) return null;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [found.email]);
  const row = (await db.query('SELECT * FROM app_pending_registration WHERE token_hash=$1 FOR UPDATE', [digest(token)])).rows[0];
  if (!row) return null;
  if (row.expires_at <= new Date()) throw new AppError(400, 'CONFIRMATION_INVALID', 'This confirmation link is invalid or expired. Request a new email.');
  const id = await new UserModel(db).create({ firstName:row.first_name,lastName:row.last_name,email:row.email,
    phone:row.phone,dob:row.dob.toISOString ? row.dob.toISOString().slice(0,10) : row.dob,password:row.password_hash });
  await updateNotificationPreferences(db, id, { enabled:true,timeZone:row.time_zone });
  await db.query('DELETE FROM app_pending_registration WHERE id=$1', [row.id]);
  await enqueueNotification(db, { userId:id,kind:'account_created',dedupeKey:`account-created:${id}`,payload:{} });
  return id;
}

/** Password-authenticated resends can correct a typo without exposing or activating a member account. */
export async function resendRegistration(db: Database, email: string, password: string, newEmail: string | undefined, origin: string) {
  // Sorted email locks also serialize two requests attempting to exchange addresses.
  for (const address of [...new Set([email, newEmail ?? email])].sort())
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [address]);
  const row = (await db.query('SELECT * FROM app_pending_registration WHERE email=$1 FOR UPDATE', [email])).rows[0];
  if (!row || !await verifyPassword(password, row.password_hash)) return false;
  if (row.sent_at && Date.now() - row.sent_at.getTime() < 60_000)
    throw new AppError(429, 'CONFIRMATION_RATE_LIMITED', 'Wait one minute before requesting another confirmation.');
  if (newEmail) {
    if ((await db.query('SELECT 1 FROM "user" WHERE lower(email)=$1', [newEmail])).rows.length) return true;
    await db.query('UPDATE app_pending_registration SET email=$2 WHERE id=$1', [row.id,newEmail]);
  }
  await sendRegistrationConfirmation(db, row.id, origin);
  return true;
}
