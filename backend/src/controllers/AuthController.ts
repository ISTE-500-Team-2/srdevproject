import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { transaction } from '../db.js';
import { AppError, emailField, passwordField, textField } from '../domain.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { UserModel } from '../models/UserModel.js';
import { SessionModel } from '../models/SessionModel.js';
import { authState, cookieName, sessionToken } from '../middleware/auth.js';

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
    const sessions = new SessionModel(this.pool, this.config.jwtKey);
    // A successful login rotates the browser's previous session.
    const previous = sessionToken(req);
    if (previous) await sessions.remove(previous);
    const session = await sessions.create(userId, remember);
    res.cookie(cookieName, session.token, {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: 'lax',
      path: '/api',
      ...(remember ? { maxAge: session.ttl } : {}),
    });
    res.json({ data: { user, csrfToken: session.csrfToken } });
  }
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
    const { user, csrfToken } = authState(res);
    res.json({ data: { user, csrfToken } });
  };
  logout = async (_req: Request, res: Response) => {
    await new SessionModel(this.pool, this.config.jwtKey).remove(authState(res).token);
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
