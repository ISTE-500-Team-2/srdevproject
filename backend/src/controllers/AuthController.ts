import { issueEmailConfirmation, consumeEmailConfirmation } from '../confirmation/emailConfirmation.js';
import { updateNotificationPreferences, validTimeZone } from '../notifications/store.js';
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
  textField,
} from '../domain.js';
import {
  hashPassword,
  verifyPassword,
  needsPasswordUpgrade,
} from '../passwords.js';
import { UserModel } from '../models/UserModel.js';
import { SessionModel } from '../models/SessionModel.js';
import { authState, cookieName, refreshToken } from '../middleware/auth.js';
import { renderNotificationTemplate, type NotificationTemplate } from '../notifications.js';

export class AuthController {
  private dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(
    private pool: Pool,
    private config: AppConfig,
  ) {}
  private async establish(
    req: Request,
    res: Response,
    userId: number,
    remember: boolean,
    notification?: NotificationTemplate,
  ) {
    const user = await new UserModel(this.pool).findById(userId);
    if (!user || user.status !== 'active')
      throw new AppError(
        403,
        'ACCOUNT_INACTIVE',
        'This account does not currently have access.',
      );
    const confirmation = await this.pool.query('SELECT email_confirmed FROM "user" WHERE userid=$1',[userId]);
    if (!confirmation.rows[0]?.email_confirmed) throw new AppError(403,'EMAIL_CONFIRMATION_REQUIRED','Confirm your email before signing in.');
    const session = await transaction(this.pool, async db => {
      const sessions = new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds);
      const previous = refreshToken(req);
      if (previous) await sessions.revokeRefresh(previous);
      return sessions.create(userId, remember);
    });
    this.respond(res, session, notification);
  }
  private respond(
    res: Response,
    session: {token:string;refreshToken:string;csrfToken:string;ttl:number;user:unknown;persistent:boolean},
    notification?: NotificationTemplate,
  ) {
    res.set('Cache-Control','no-store');
    res.clearCookie('arbor_session',{path:'/api'});
    res.cookie(cookieName,session.refreshToken,{httpOnly:true,secure:this.config.secureCookies,sameSite:'lax',path:'/api',...(session.persistent ? {maxAge:(this.config.refreshTokenSeconds ?? 30*86400)*1000} : {})});
    res.json({
      data: {
        user: session.user,
        csrfToken: session.csrfToken,
        accessToken: session.token,
        expiresIn: session.ttl / 1000,
        ...(notification ? { notification } : {}),
      },
    });
  }
  csrf = async (req: Request,res: Response) => {
    res.set('Cache-Control','no-store');
    const csrfToken = await new SessionModel(this.pool,this.config.jwtKey).refreshCsrf(refreshToken(req));
    if (!csrfToken) throw new AppError(401,'UNAUTHENTICATED','Sign in to continue.');
    res.json({data:{csrfToken}});
  };
  refresh = async (req: Request,res: Response) => {
    const session = await transaction(this.pool,db => new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds).rotate(refreshToken(req),req.get('X-CSRF-Token') ?? ''));
    if (!session) throw new AppError(401,'UNAUTHENTICATED','Sign in to continue.');
    this.respond(res,session);
  };

  login = async (req: Request, res: Response) => {
    const email = emailField(req.body.email);
    const password = passwordField(req.body.password);
    const account = await new UserModel(this.pool).credentials(email);
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
    if (needsPasswordUpgrade(account.password) && Buffer.byteLength(password,'utf8') <= 72) {
      const upgraded = await hashPassword(password);
      await this.pool.query('UPDATE "user" SET password=$1 WHERE userid=$2 AND password=$3',[upgraded,account.id,account.password]);
    }
    await this.establish(req, res, account.id, req.body.remember === true);
  };
  register = async (req: Request, res: Response) => {
    const timeZone = req.body.timeZone ?? this.config.timeZone;
    if (!validTimeZone(timeZone)) throw new AppError(400,'INVALID_INPUT','Choose a valid IANA time zone.');
    const input = {
      firstName: textField(req.body.firstName, 'First name', 50),
      lastName: textField(req.body.lastName, 'Last name', 50),
      phone: textField(req.body.phone, 'Phone', 15),
      email: emailField(req.body.email),
      dob: dateOfBirthField(req.body.dob),
      password: await hashPassword(newPasswordField(req.body.password)),
    };
    let id: number;

    try {
      id = await transaction(this.pool, async (db) => {
        const userId = await new UserModel(db).create(input);
        await updateNotificationPreferences(db,userId,{enabled:true,timeZone});
        await db.query('UPDATE "user" SET email_confirmed=false WHERE userid=$1',[userId]);
        await issueEmailConfirmation(db,userId,this.config.notifications?.appOrigin ?? this.config.allowedOrigins[0]!);
        return userId;
      });
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
      const userId=await consumeEmailConfirmation(db,req.body.token);
      const session = await new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds).create(userId,false);
      const user = await new UserModel(db).findById(userId);
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
    const newEmail=req.body.newEmail == null ? undefined : emailField(req.body.newEmail);
    const account=await new UserModel(this.pool).credentials(email);
    const valid=await verifyPassword(password,account?.password ?? await this.dummyHash);
    if(account && valid && !account.emailConfirmed) {
      try {
        await transaction(this.pool,async db => {
          const current=(await db.query('SELECT email_confirmed,status FROM "user" WHERE userid=$1 FOR UPDATE',[account.id])).rows[0];
          if(!current || current.email_confirmed || current.status!=='active')return;
          const previous=(await db.query('SELECT created_at FROM app_email_confirmation WHERE userid=$1',[account.id])).rows[0];
          if(previous && Date.now()-new Date(previous.created_at).getTime()<60000)
            throw new AppError(429,'CONFIRMATION_RATE_LIMITED','Wait one minute before requesting another confirmation.');
          if(newEmail)await db.query('UPDATE "user" SET email=$2,revision=revision+1 WHERE userid=$1',[account.id,newEmail]);
          await issueEmailConfirmation(db,account.id,this.config.notifications?.appOrigin ?? this.config.allowedOrigins[0]!);
        });
      } catch(error) {
        // Duplicate new address must not reveal another account's existence.
        if(!(typeof error==='object' && error && 'code' in error && error.code==='23505'))throw error;
      }
    }
    res.set('Cache-Control','no-store');
    res.status(202).json({data:{emailSendingEnabled:!!this.config.notifications,message:this.config.notifications
      ? 'If the supplied credentials match an unconfirmed account and notifications are enabled, a confirmation email has been queued for sending. Check your inbox and spam folder.'
      : 'Email delivery is disabled in this environment. No confirmation email will be sent. Use a development demo account or run the email-enabled setup.'}});
  };
  current = async (_req: Request, res: Response) => {
    res.set("Cache-Control","no-store");
    const { user, csrfToken } = authState(res);
    res.json({ data: { user, csrfToken } });
  };
  logout = async (_req: Request, res: Response) => {
    await new SessionModel(this.pool, this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds).remove(authState(res).token);
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
