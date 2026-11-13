import { consumeRegistration, pruneRegistrations, stageRegistration } from '../confirmation/pendingRegistration.js';
import { consumeEmailConfirmation } from '../confirmation/emailConfirmation.js';
import { RecoveryService } from '../services/RecoveryService.js';
import { auditContext } from '../auditContext.js';
import { validTimeZone } from '../notifications/store.js';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { transaction } from '../db.js';
import {
  AppError,
  dateOfBirthField,
  emailField,
  newPasswordField,
  passwordField,
  publicUser,
  textField,
  type UserView,
} from '../domain.js';
import {
  hashPassword,
  verifyPassword,
  needsPasswordUpgrade,
} from '../passwords.js';
import { UserModel } from '../models/UserModel.js';
import { accountModeView } from "../accountMode.js";
import { SessionModel } from '../models/SessionModel.js';
import { authState, cookieName, refreshToken } from '../middleware/auth.js';
import { renderNotificationTemplate, type NotificationTemplate } from '../notifications.js';

/** Signup errors name the request-body property they are about, so the form can show that step. */
function signupField<T>(field: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof AppError) error.field = field;
    throw error;
  }
}

export class AuthController {
  private dummyHash = hashPassword(randomBytes(32).toString('hex'));
  private recovery: RecoveryService;
  constructor(
    private pool: Pool,
    private config: AppConfig,
  ) {
    this.recovery = new RecoveryService(pool, config, this.dummyHash);
  }
  private async establish(
    req: Request,
    res: Response,
    userId: number,
    remember: boolean,
    notification?: NotificationTemplate,
    verifiedPasswordHash?: string,
  ) {
    const user = await new UserModel(this.pool,this.config.timeZone).findById(userId);
    if (!user || user.status !== 'active' || user.accessStatus !== 'active')
      throw new AppError(
        403,
        'ACCOUNT_INACTIVE',
        'This account does not currently have access. Please see staff.',
      );
    const confirmation = await this.pool.query('SELECT email_confirmed FROM "user" WHERE userid=$1',[userId]);
    const context = auditContext.getStore();
    if (context) context.actorId = userId;
    if (!confirmation.rows[0]?.email_confirmed) throw new AppError(403,'EMAIL_CONFIRMATION_REQUIRED','Confirm your email before signing in.');
    const session = await transaction(this.pool, async db => {
      const locked = (await db.query('SELECT password FROM "user" WHERE userid=$1 FOR SHARE', [userId])).rows[0];
      // A reset may finish after password verification but before session creation.
      // Recheck under the same account lock used by reset and keep it until commit.
      if (verifiedPasswordHash && locked?.password !== verifiedPasswordHash)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const sessions = new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds,this.config.timeZone);
      const previous = refreshToken(req);
      if (previous) await sessions.revokeRefresh(previous);
      return sessions.create(userId, remember);
    });
    this.respond(res, session, notification);
  }
  private respond(
    res: Response,
    session: {token:string;refreshToken:string;csrfToken:string;ttl:number;user:UserView;persistent:boolean},
    notification?: NotificationTemplate,
  ) {
    res.set('Cache-Control','no-store');
    res.clearCookie('arbor_session',{path:'/api'});
    res.cookie(cookieName,session.refreshToken,{httpOnly:true,secure:this.config.secureCookies,sameSite:'lax',path:'/api',...(session.persistent ? {maxAge:(this.config.refreshTokenSeconds ?? 30*86400)*1000} : {})});
    res.json({
      data: {
        user: publicUser(session.user),
        csrfToken: session.csrfToken,
        accessToken: session.token,
        expiresIn: session.ttl / 1000,
        ...(notification ? { notification } : {}),
      },
    });
  }
  csrf = async (req: Request,res: Response) => {
    res.set('Cache-Control','no-store');
    // Signed out is an ordinary answer here, not an error: the app asks on every
    // visit, and a 401 would log a console error for each signed-out page load.
    const token = refreshToken(req);
    const csrfToken = token ? await new SessionModel(this.pool,this.config.jwtKey).refreshCsrf(token) : undefined;
    res.json({data:{csrfToken:csrfToken ?? null}});
  };
  refresh = async (req: Request,res: Response) => {
    const session = await transaction(this.pool,db => new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds,this.config.timeZone).rotate(refreshToken(req),req.get('X-CSRF-Token') ?? ''));
    if (!session) throw new AppError(401,'UNAUTHENTICATED','Sign in to continue.');
    this.respond(res,session);
  };

  login = async (req: Request, res: Response) => {
    const email = emailField(req.body.email);
    const password = passwordField(req.body.password);
    const account = await new UserModel(this.pool).credentials(email);
    // Temporary requests never become members until inbox confirmation.
    if (!account) {
      const pending = (await this.pool.query('SELECT password_hash FROM app_pending_registration WHERE email=$1 AND expires_at>NOW()', [email])).rows[0];
      if (pending && await verifyPassword(password,pending.password_hash))
        throw new AppError(403,'EMAIL_CONFIRMATION_REQUIRED','Confirm your email before signing in.');
    }
    const valid = await verifyPassword(
      password,
      account?.password ?? (await this.dummyHash),
    );
    if (!account || !valid)
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Email or password is incorrect.',
      );
    // Legacy unverified accounts retain their recovery flow after migration removes active status.
    if (!account.emailConfirmed) {
      const row = (await this.pool.query('SELECT status FROM "user" WHERE userid=$1',[account.id])).rows[0];
      if (row && ['active','pending'].includes(row.status))
        throw new AppError(403,'EMAIL_CONFIRMATION_REQUIRED','Confirm your email before signing in.');
    }
    if (needsPasswordUpgrade(account.password) && Buffer.byteLength(password,'utf8') <= 72) {
      const upgraded = await hashPassword(password);
      const update = await this.pool.query('UPDATE "user" SET password=$1 WHERE userid=$2 AND password=$3',[upgraded,account.id,account.password]);
      if (update.rowCount) account.password = upgraded;
      else {
        // Another login may have upgraded the same legacy hash. Accept its hash
        // only after verifying it; a concurrent reset to a different password fails.
        const current = await new UserModel(this.pool).credentials(email);
        if (!current || current.id !== account.id || !await verifyPassword(password, current.password))
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
        account.password = current.password;
      }
    }
    await this.establish(req, res, account.id, req.body.remember === true, undefined, account.password);
  };
  register = async (req: Request, res: Response) => {
    const timeZone = req.body.timeZone ?? this.config.timeZone;
    if (!validTimeZone(timeZone)) throw new AppError(400,'INVALID_INPUT','Choose a valid IANA time zone.','timeZone');
    const input = {
      firstName: signupField('firstName', () => textField(req.body.firstName, 'First name', 50)),
      lastName: signupField('lastName', () => textField(req.body.lastName, 'Last name', 50)),
      phone: signupField('phone', () => textField(req.body.phone, 'Phone', 15)),
      // The shared validator uses the same address identity rules as login and recovery.
      email: signupField('email', () => emailField(req.body.email)),
      dob: signupField('dob', () => dateOfBirthField(req.body.dob)),
      password: await hashPassword(signupField('password', () => newPasswordField(req.body.password))),
    };
    // Public registrations remain temporary requests until an inbox token is consumed.
    await pruneRegistrations(this.pool);

    try {
      await transaction(this.pool, db => stageRegistration(db, { ...input, timeZone },
        this.config.notifications?.appOrigin ?? this.config.allowedOrigins[0]!));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with that email address already exists.',
          'email',
        );
      }

      throw error;
    }
    const notification = renderNotificationTemplate('accountCreation', {
      firstName: input.firstName,
      email: input.email,
    });
    res.set('Cache-Control','no-store');
    res.status(202).json({data:{confirmationRequired:true,email:input.email,emailSendingEnabled:!!this.config.notifications,notification}});
  };
  confirm = async (req: Request,res: Response) => {
    const { session, notification } = await transaction(this.pool,async db => {
      // Existing confirmation links remain usable; new sign-ups allocate their account here.
      const userId=await consumeRegistration(db,req.body.token) ?? await consumeEmailConfirmation(db,req.body.token);
      const session = await new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds,this.config.timeZone).create(userId,false);
      const user = await new UserModel(db,this.config.timeZone).findById(userId);
      const notification = renderNotificationTemplate('accountCreation', {
        firstName: user?.firstName ?? '',
        email: user?.email ?? '',
      });
      return { session, notification };
    });
    this.respond(res,session,notification);
  };
  confirmation = async (req: Request,res: Response) => {
    const email=emailField(req.body.email);
    const password=passwordField(req.body.password);
    // Corrected addresses use the same validation and identity rules as every other email flow.
    const newEmail=req.body.newEmail == null ? undefined : emailField(req.body.newEmail);
    await this.recovery.resendConfirmation(email,password,newEmail);
    res.set('Cache-Control','no-store');
    res.status(202).json({data:{emailSendingEnabled:!!this.config.notifications,message:this.config.notifications
      ? 'If the supplied credentials match an unconfirmed account and notifications are enabled, a confirmation email has been queued for sending. Check your inbox and spam folder.'
      : 'Email delivery is disabled in this environment. No confirmation email will be sent. Use a development demo account or run the email-enabled setup.'}});
  };
  passwordReset = async (req: Request, res: Response) => {
    const email = emailField(req.body.email);
    await this.recovery.requestPasswordReset(email);
    res.status(202).json({ data: { message: 'If an account uses this email, a reset link is on its way. It expires in 30 minutes.' } });
  };
  adminPasswordReset = async (req: Request, res: Response) => {
    await this.recovery.adminPasswordReset(authState(res).user, req.params.id);
    res.status(202).json({ data: { message: 'Password reset email queued. The link expires in 30 minutes.' } });
  };
  checkPasswordReset = async (req: Request, res: Response) => {
    await this.recovery.checkPasswordReset(req.body.token);
    res.status(204).end();
  };
  confirmPasswordReset = async (req: Request, res: Response) => {
    const password = newPasswordField(req.body.password);
    await this.recovery.completePasswordReset(req.body.token, password);
    res.status(204).end();
  };
  current = async (_req: Request, res: Response) => {
    res.set("Cache-Control","no-store");
    const { user, actor, csrfToken } = authState(res);
    res.json({ data: { ...accountModeView(user, actor), csrfToken } });
  };
  logout = async (_req: Request, res: Response) => {
    await new SessionModel(this.pool, this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds,this.config.timeZone).remove(authState(res).token);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: 'lax',
      path: '/api',
    });
    res.status(204).end();
  };
  demo = async (req: Request, res: Response) => {
    if (!this.config.demoLogin)
      throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const account = await new UserModel(this.pool).credentials(
      `demo.${role}@collaboratory.invalid`,
    );
    if (!account)
      throw new AppError(
        503,
        'DEMO_NOT_SEEDED',
        'The isolated demo database has not been prepared.',
      );
    await this.establish(req, res, account.id, false);
  };
}
