import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { transaction, type Database } from '../db.js';
import { AppError, positiveId } from '../domain.js';
import { verifyPassword } from '../passwords.js';
import { UserModel } from '../models/UserModel.js';
import { resendRegistration } from '../confirmation/pendingRegistration.js';
import { issueEmailConfirmation } from '../confirmation/emailConfirmation.js';
import { checkPasswordReset, consumePasswordReset, issuePasswordReset } from '../confirmation/passwordReset.js';

interface ResetAccount { userid: number; status: string }

// One reset policy for self-service and administrator requests. The caller holds
// the account row lock (FOR UPDATE) for the whole transaction.
const resetAllowed = (account: ResetAccount): boolean => account.status === 'active';
async function resetRequestedRecently(db: Database, userId: number): Promise<boolean> {
  const recent = await db.query(`SELECT 1 FROM app_password_reset
    WHERE userid=$1 AND created_at>NOW()-INTERVAL '1 minute'`, [userId]);
  return recent.rows.length > 0;
}

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

/** Account recovery: confirmation resends, password reset requests and completion. */
export class RecoveryService {
  constructor(
    private pool: Pool,
    private config: AppConfig,
    /** The bcrypt hash compared against when no real password hash exists. */
    private dummyHash: Promise<string>,
  ) {}

  private get origin() {
    return this.config.notifications?.appOrigin ?? this.config.allowedOrigins[0]!;
  }

  /** Resends a confirmation to a pending registration or legacy unconfirmed account. Never reveals which, if any, matched. */
  async resendConfirmation(email: string, password: string, newEmail: string | undefined) {
    // A pending registration has no user ID; authenticate and resend its staged request first.
    const pending = await transaction(this.pool, db => resendRegistration(db, email, password, newEmail, this.origin)).catch(error => {
      if (error?.code === '23505') return true;
      throw error;
    });
    const account = await new UserModel(this.pool).credentials(email);
    const valid = await verifyPassword(password, account?.password ?? await this.dummyHash);
    if (pending || !account || !valid || account.emailConfirmed) return;
    try {
      await transaction(this.pool, async db => {
        const current = (await db.query('SELECT email_confirmed,status FROM "user" WHERE userid=$1 FOR UPDATE', [account.id])).rows[0];
        if (!current || current.email_confirmed || !['active', 'pending'].includes(current.status)) return;
        const previous = (await db.query('SELECT created_at FROM app_email_confirmation WHERE userid=$1', [account.id])).rows[0];
        if (previous && Date.now() - new Date(previous.created_at).getTime() < 60000)
          throw new AppError(429, 'CONFIRMATION_RATE_LIMITED', 'Wait one minute before requesting another confirmation.');
        if (newEmail) {
          await db.query('UPDATE "user" SET email=$2,revision=revision+1 WHERE userid=$1', [account.id, newEmail]);
          // A link sent to the old inbox must not confirm ownership of the new one.
          await db.query('DELETE FROM app_password_reset WHERE userid=$1', [account.id]);
          await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=NOW()
            WHERE userid=$1 AND kind='password_reset' AND status='pending'`, [account.id]);
        }
        await issueEmailConfirmation(db, account.id, this.origin);
      });
    } catch (error) {
      // Duplicate new address must not reveal another account's existence.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Self-service request: unknown, inactive and throttled accounts are silently skipped. */
  async requestPasswordReset(email: string) {
    // Every valid email performs the same bcrypt work, including unknown, inactive,
    // and throttled accounts. Run it alongside the short database operation so the
    // response does not have a fast account-existence branch.
    const dummy = await this.dummyHash;
    await Promise.all([
      verifyPassword('password-reset-request', dummy),
      transaction(this.pool, async db => {
        const account = (await db.query<ResetAccount>('SELECT userid,status FROM "user" WHERE lower(email)=$1 FOR UPDATE', [email])).rows[0];
        if (!account || !resetAllowed(account) || await resetRequestedRecently(db, account.userid)) return;
        await issuePasswordReset(db, account.userid, this.origin);
      }),
    ]);
  }

  /** Administrator request: every refusal is reported, and the request is audited. */
  async adminPasswordReset(actor: { id: number; roles: string[] }, subject: unknown) {
    if (!actor.roles.includes('admin'))
      throw new AppError(403, 'ADMIN_REQUIRED', 'Only administrators can send password reset emails.');
    const id = positiveId(subject);
    await transaction(this.pool, async db => {
      const account = (await db.query<ResetAccount>('SELECT userid,status FROM "user" WHERE userid=$1 FOR UPDATE', [id])).rows[0];
      if (!account) throw new AppError(404, 'NOT_FOUND', 'That account no longer exists.');
      if (!resetAllowed(account))
        throw new AppError(409, 'ACCOUNT_INACTIVE', 'Password resets are only available for active accounts.');
      if (!this.config.notifications)
        throw new AppError(503, 'EMAIL_DISABLED', 'Email delivery is disabled in this environment. No reset email was sent.');
      if (await resetRequestedRecently(db, id))
        throw new AppError(429, 'RESET_RECENT', 'A reset email was requested recently. Wait one minute before sending another.');
      await issuePasswordReset(db, id, this.config.notifications.appOrigin);
      await db.query(`INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason)
        VALUES($1,$2,'user.password_reset_requested','user',$2,'Administrator requested a password reset email')`, [actor.id, id]);
    });
  }

  checkPasswordReset(token: unknown) {
    return checkPasswordReset(this.pool, token);
  }

  completePasswordReset(token: unknown, password: string) {
    return transaction(this.pool, db => consumePasswordReset(db, token, password));
  }
}
