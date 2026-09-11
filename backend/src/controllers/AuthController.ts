import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { transaction } from '../db.js';
import { AppError, emailField, passwordField, textField } from '../domain.js';
import { hashPassword, verifyPassword, needsPasswordUpgrade } from '../passwords.js';
import { UserModel } from '../models/UserModel.js';
import { SessionModel } from '../models/SessionModel.js';
import { authState, cookieName, refreshToken } from '../middleware/auth.js';

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
  ) {
    const user = await new UserModel(this.pool).findById(userId);
    if (!user || user.status !== 'active')
      throw new AppError(
        403,
        'ACCOUNT_INACTIVE',
        'This account does not currently have access.',
      );
    const session = await transaction(this.pool, async db => {
      const sessions = new SessionModel(db,this.config.jwtKey,this.config.accessTokenSeconds,this.config.refreshTokenSeconds);
      const previous = refreshToken(req);
      if (previous) await sessions.revokeRefresh(previous);
      return sessions.create(userId, remember);
    });
    this.respond(res,session);
  }
  private respond(res: Response, session: {token:string;refreshToken:string;csrfToken:string;ttl:number;user:unknown;persistent:boolean}) {
    res.set('Cache-Control','no-store');
    res.clearCookie('arbor_session',{path:'/api'});
    res.cookie(cookieName,session.refreshToken,{httpOnly:true,secure:this.config.secureCookies,sameSite:'lax',path:'/api',...(session.persistent ? {maxAge:(this.config.refreshTokenSeconds ?? 30*86400)*1000} : {})});
    res.json({data:{user:session.user,csrfToken:session.csrfToken,accessToken:session.token,expiresIn:session.ttl/1000}});
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
    const input = {
      firstName: textField(req.body.firstName, 'First name', 50),
      lastName: textField(req.body.lastName, 'Last name', 50),
      phone: textField(req.body.phone, 'Phone', 15),
      email: emailField(req.body.email),
      password: await hashPassword(passwordField(req.body.password)),
    };
    const id = await transaction(this.pool, (db) =>
      new UserModel(db).create(input),
    );
    res.status(201);
    await this.establish(req, res, id, false);
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
