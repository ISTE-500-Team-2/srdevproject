// Members change their own sign-in email and password. Both need the current password; a password
// change signs out every other device, and an email change waits for the new address's link.

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { transaction, type Database } from '../db.js';
import { AppError } from '../domain.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { enqueueNotification } from '../notifications/store.js';
import { SessionModel, tokenHash, type IssuedSession } from '../models/SessionModel.js';
import { StaffModel } from '../models/StaffModel.js';
import {
  cancelEmailChange, consumeEmailChange, emailTaken, issueEmailChange, pendingEmailChange, type PendingEmail,
} from '../confirmation/emailChange.js';

const wrongPassword = () =>
  new AppError(400, 'CURRENT_PASSWORD_INVALID', 'Your current password is incorrect.', 'currentPassword');
const resendWait = 60_000;

export class SignInChangeService {
  constructor(
    private pool: Pool,
    private config: AppConfig,
  ) {}

  private get origin() {
    return this.config.notifications?.appOrigin ?? this.config.allowedOrigins[0]!;
  }

  private sessions(db: Database) {
    return new SessionModel(db, this.config.jwtKey, this.config.accessTokenSeconds, this.config.refreshTokenSeconds, this.config.timeZone);
  }

  /** The stored hash, once `password` is shown to match it. */
  private async checkPassword(userId: number, password: unknown): Promise<string> {
    if (typeof password !== 'string' || !password)
      throw new AppError(400, 'INVALID_INPUT', 'Enter your current password.', 'currentPassword');
    const stored = (await this.pool.query<{ password: string }>('SELECT password FROM "user" WHERE userid=$1', [userId])).rows[0]?.password;
    if (!stored || !(await verifyPassword(password, stored))) throw wrongPassword();
    return stored;
  }

  /** Lock the account and make sure the password checked above is still the one on file. */
  private async lockAccount(db: Database, userId: number, checkedHash: string) {
    const account = (await db.query<{ email: string; password: string }>(
      'SELECT email,password FROM "user" WHERE userid=$1 FOR UPDATE', [userId])).rows[0];
    // A reset or another change committed between the check and this lock.
    if (!account || account.password !== checkedHash) throw wrongPassword();
    return account;
  }

  /**
   * Save a new password, end every sign-in (other browsers included) and return a fresh one for
   * this browser, as long-lived as the sign-in it replaces.
   */
  async changePassword(userId: number, current: unknown, next: string, refreshToken: string): Promise<IssuedSession> {
    const checked = await this.checkPassword(userId, current);
    if (await verifyPassword(next, checked))
      throw new AppError(400, 'PASSWORD_UNCHANGED', 'That’s your current password. Choose a new one.', 'newPassword');
    const encoded = await hashPassword(next);
    return transaction(this.pool, async (db) => {
      await this.lockAccount(db, userId, checked);
      const family = refreshToken
        ? (await db.query<{ persistent: boolean }>(`SELECT f.persistent FROM app_refresh_token t
            JOIN app_refresh_family f ON f.id=t.family_id WHERE t.token_hash=$1 AND f.userid=$2`, [tokenHash(refreshToken), userId])).rows[0]
        : undefined;
      await db.query('UPDATE "user" SET password=$2,password_changed_at=NOW() WHERE userid=$1', [userId, encoded]);
      await db.query('UPDATE app_refresh_family SET revoked=true WHERE userid=$1', [userId]);
      await db.query('DELETE FROM app_session WHERE userid=$1', [userId]);
      // A reset link sent before the change would undo it, and an email change asked for before it
      // may have come from whoever the member is locking out.
      await db.query('DELETE FROM app_password_reset WHERE userid=$1', [userId]);
      await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
        WHERE userid=$1 AND kind='password_reset' AND status='pending'`, [userId]);
      const cancelled = await cancelEmailChange(db, userId);
      await enqueueNotification(db, { userId, kind: 'password_changed', dedupeKey: `password-changed:${randomUUID()}`, payload: {} });
      const staff = new StaffModel(db, this.config.timeZone);
      await staff.audit(userId, userId, 'profile.password_changed', 'user', userId, 'Member changed their password', null, null);
      if (cancelled)
        await staff.audit(userId, userId, 'profile.email_change_cancelled', 'user', userId,
          'Cancelled because the password was changed', { pendingEmail: cancelled }, null);
      return this.sessions(db).create(userId, family?.persistent ?? false);
    });
  }

  /** Send a confirmation link to `email`. The sign-in email stays the same until it is opened. */
  async requestEmailChange(userId: number, email: string, current: unknown): Promise<PendingEmail> {
    const checked = await this.checkPassword(userId, current);
    return transaction(this.pool, async (db) => {
      const account = await this.lockAccount(db, userId, checked);
      if (account.email.toLowerCase() === email)
        throw new AppError(400, 'EMAIL_UNCHANGED', 'That’s already your email.', 'email');
      // Sign-up says the same thing about an address that's in use.
      if (await emailTaken(db, email, userId))
        throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with that email address already exists.', 'email');
      // Asking again for the same address is a resend; a different one (a typo fixed) replaces it at
      // once, and the current address hears about each address asked for.
      const sameAddress = (await pendingEmailChange(db, userId))?.email === email;
      if (sameAddress) await this.throttle(db, userId);
      const pending = await issueEmailChange(db, userId, account.email, email, this.origin, { notifyCurrent: !sameAddress });
      await new StaffModel(db, this.config.timeZone).audit(userId, userId, 'profile.email_change_requested', 'user', userId,
        'Member asked to change their sign-in email', { email: account.email }, { pendingEmail: email });
      return pending;
    });
  }

  /** Send the pending change's link again, with a new token. */
  async resendEmailChange(userId: number): Promise<PendingEmail> {
    return transaction(this.pool, async (db) => {
      const account = (await db.query<{ email: string }>('SELECT email FROM "user" WHERE userid=$1 FOR UPDATE', [userId])).rows[0]!;
      const pending = await pendingEmailChange(db, userId);
      if (!pending) throw new AppError(404, 'NOT_FOUND', 'There’s no email change waiting to be confirmed.');
      if (await emailTaken(db, pending.email, userId))
        throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with that email address already exists.', 'email');
      await this.throttle(db, userId);
      return issueEmailChange(db, userId, account.email, pending.email, this.origin, { notifyCurrent: false });
    });
  }

  async cancelEmailChange(userId: number): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query('SELECT 1 FROM "user" WHERE userid=$1 FOR UPDATE', [userId]);
      const cancelled = await cancelEmailChange(db, userId);
      if (!cancelled) return;
      await new StaffModel(db, this.config.timeZone).audit(userId, userId, 'profile.email_change_cancelled', 'user', userId,
        'Member cancelled their email change', { pendingEmail: cancelled }, null);
    });
  }

  /** Apply the change a link was sent for; anyone holding the link may open it. */
  async confirmEmailChange(token: unknown) {
    return transaction(this.pool, async (db) => {
      const changed = await consumeEmailChange(db, token);
      await new StaffModel(db, this.config.timeZone).audit(changed.userId, changed.userId, 'profile.email_changed', 'user',
        changed.userId, 'Member confirmed their new sign-in email', { email: changed.previousEmail }, { email: changed.email });
      return changed;
    });
  }

  /** One link a minute, so a member can't be used to flood an inbox. */
  private async throttle(db: Database, userId: number) {
    const pending = await pendingEmailChange(db, userId);
    if (pending && Date.now() - new Date(pending.createdAt).getTime() < resendWait)
      throw new AppError(429, 'EMAIL_CHANGE_RECENT', 'A link was sent less than a minute ago. Wait a minute before sending another.');
  }
}
