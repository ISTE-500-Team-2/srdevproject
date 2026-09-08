import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export class SessionModel {
  constructor(private db: Database) {}
  async create(userId: number, remember: boolean) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('hex');
    const ttl = remember ? 7 * 24 * 3600000 : 12 * 3600000;
    await this.db.query('DELETE FROM app_session WHERE expires_at <= NOW()');
    await this.db.query(
      'INSERT INTO app_session (token_hash,userid,csrf_token,expires_at) VALUES ($1,$2,$3,$4)',
      [tokenHash(token), userId, csrfToken, new Date(Date.now() + ttl)],
    );
    return { token, csrfToken, ttl };
  }
  async find(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.db.query<{ userId: number; csrfToken: string }>(
      'SELECT userid AS "userId",csrf_token AS "csrfToken" FROM app_session WHERE token_hash=$1 AND expires_at>NOW()',
      [tokenHash(token)],
    );
    return rows[0] ?? null;
  }
  async remove(token: string) {
    await this.db.query('DELETE FROM app_session WHERE token_hash=$1', [
      tokenHash(token),
    ]);
  }
}
