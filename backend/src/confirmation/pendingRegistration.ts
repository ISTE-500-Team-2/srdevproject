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
// The old release looks up SHA-256 hex. The prefix keeps new hashes outside that
// namespace, and base64url fits the full digest and prefix in the existing column.
const passwordBoundDigest = (token: string) => `v2:${createHash('sha256').update(token).digest('base64url')}`;
const legacyDigest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Expired requests and their queued mail are removed without ever creating member records. */
/**
 * Remove expired staged sign-ups so unconfirmed personal data does not remain in the pending roster
 * indefinitely.
 */
export async function pruneRegistrations(db: Database) {
  await db.query('DELETE FROM app_pending_registration WHERE expires_at<=NOW()');
}

/** Sign-ups email one pending address at most this many confirmation links an hour. */
const signupEmailsPerHour = 3;

/** Queued mail must never deliver a link that a newer one (or none) has replaced. */
async function retireQueuedLinks(db: Database, id: number) {
  await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
    WHERE registration_id=$1 AND status='pending'`, [id]);
}

/** Only the latest token can complete a request; resends invalidate earlier queued links. */
export async function sendRegistrationConfirmation(db: Database, id: number, origin: string) {
  const token = randomBytes(32).toString('base64url');
  const hash = passwordBoundDigest(token);
  const expires = new Date(Date.now() + 24 * 60 * 60_000);
  await retireQueuedLinks(db, id);
  await db.query(`UPDATE app_pending_registration
    SET confirmation_requires_password=true,token_hash=$2,expires_at=$3,sent_at=NOW() WHERE id=$1`, [id, hash, expires]);
  const url = new URL('/confirm-email', origin); url.hash = token;
  await db.query(`INSERT INTO app_notification_outbox(registration_id,kind,dedupe_key,payload,deadline_at,counts_for_sla)
    VALUES($1,'account_confirmation',$2,$3::jsonb,NOW()+INTERVAL '5 minutes',false)`,
    [id, `registration:${hash}`, JSON.stringify({ confirmationUrl: url.href, confirmationHash: hash, expiresAt: expires.toISOString() })]);
}

/**
 * Tell the member who signs in with an address that someone tried to use it for another account
 * (a sign-up, or another member's email change), at most once in any hour.
 * The caller owns the transaction.
 */
export async function noticeAddressInUse(db: Database, userId: number) {
  // Serialize both entry points so two concurrent attempts cannot each see an empty hour.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [`account-exists:${userId}`]);
  const recent = await db.query(`SELECT 1 FROM app_notification_outbox
    WHERE userid=$1 AND kind='account_exists' AND created_at>statement_timestamp()-interval '1 hour' LIMIT 1`, [userId]);
  if (recent.rowCount) return;
  await enqueueNotification(db, { userId, kind: 'account_exists',
    dedupeKey: `account-exists:${userId}:${randomBytes(16).toString('hex')}`, payload: {} });
}

/**
 * Stage a sign-up and email its confirmation link. Every attempt looks the same to the caller, so
 * sign-up never reveals whether an address belongs to a member: an existing account's owner gets a
 * notice instead. A newer sign-up for a still-pending address replaces its details, password and
 * link, so the owner can always take back a sign-up a stranger started. Whoever signed up last, the
 * link alone never decides the password: confirming also asks for it (consumeRegistration). Sign-ups
 * send one address at most three links an hour.
 */
export async function stageRegistration(db: Database, input: RegistrationInput, origin: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [input.email]);
  const existing = (await db.query<{ userid: number }>('SELECT userid FROM "user" WHERE lower(email)=$1', [input.email])).rows[0];
  if (existing) return noticeAddressInUse(db, existing.userid);
  // Clear the previous token and mark the row even when the email cap prevents a new link.
  const row = (await db.query<{ id: number }>(`INSERT INTO app_pending_registration(
    email,first_name,last_name,phone,dob,password_hash,time_zone,confirmation_requires_password)
    VALUES($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
    phone=EXCLUDED.phone,dob=EXCLUDED.dob,password_hash=EXCLUDED.password_hash,time_zone=EXCLUDED.time_zone,
    confirmation_requires_password=true,token_hash=NULL RETURNING id`,
    [input.email,input.firstName,input.lastName,input.phone,input.dob,input.password,input.timeZone])).rows[0]!;
  // Repeat sign-ups must not flood the address's inbox. Count the links that went out, or are
  // going out, this past hour (a queued one a newer link replaced never left). Past the cap a
  // sign-up still takes the request over and every earlier link stops working, but nothing is
  // sent: the newest person to sign up can ask for a link with their password (resendRegistration).
  const { sent } = (await db.query<{ sent: number }>(`SELECT COUNT(*)::int AS sent FROM app_notification_outbox
    WHERE registration_id=$1 AND status IN ('sending','accepted','uncertain') AND created_at>NOW()-INTERVAL '1 hour'`,
    [row.id])).rows[0]!;
  if (sent < signupEmailsPerHour) return sendRegistrationConfirmation(db, row.id, origin);
  await retireQueuedLinks(db, row.id);
  // sent_at stays put: it times resends, and no email went out.
  await db.query(`UPDATE app_pending_registration SET expires_at=NOW()+INTERVAL '24 hours' WHERE id=$1`, [row.id]);
}

/**
 * Confirming takes the sign-up's password as well as the link. Every sign-up mails its link to the
 * address, so a stranger who signs the address up (before or after its owner) puts a working link in
 * the owner's inbox; if the link alone created the account, the owner could click it and get an
 * account with the stranger's password.
 */
export const confirmationPasswordMismatch = () => new AppError(401, 'CONFIRMATION_PASSWORD_MISMATCH',
  'That isn’t the password this sign-up was made with. Check it and try again, or sign up again to start over.', 'password');

/** Possession of a live, single-use inbox token is required before allocating a user, role or session. */
/**
 * Consume a valid staged confirmation and create the member once, if `password` is the one the
 * sign-up was made with; return null for a token that isn't a staged sign-up's.
 */
export async function consumeRegistration(db: Database, token: unknown, password: string): Promise<number | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hashes = [passwordBoundDigest(token), legacyDigest(token)];
  // Take the email lock before the row lock, matching registration and resend lock order.
  const found = (await db.query('SELECT email FROM app_pending_registration WHERE token_hash IN ($1,$2)', hashes)).rows[0];
  if (!found) return null;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [found.email]);
  const row = (await db.query('SELECT * FROM app_pending_registration WHERE token_hash IN ($1,$2) FOR UPDATE', hashes)).rows[0];
  if (!row) return null;
  if (row.expires_at <= new Date()) throw new AppError(400, 'CONFIRMATION_INVALID', 'This confirmation link is invalid or expired. Request a new email.');
  // A wrong password leaves the link working, so a typo can be corrected.
  if (!await verifyPassword(password, row.password_hash)) throw confirmationPasswordMismatch();
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
  const pendingAt = async (address: string) =>
    (await db.query('SELECT * FROM app_pending_registration WHERE email=$1 FOR UPDATE', [address])).rows[0];
  // The answer never says whether a correction moved anything, so the page repeats the
  // same pair on a retry: the sign-up may still wait under the old address (say the
  // password was mistyped) or already under the corrected one.
  const row = await pendingAt(email) ?? (newEmail ? await pendingAt(newEmail) : undefined);
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
