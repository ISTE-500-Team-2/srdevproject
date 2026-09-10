import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db.js';
import { JwtTokens } from '../jwt.js';

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export class SessionModel {
  private jwt: JwtTokens;
  constructor(private db: Database, key: Uint8Array) {
    this.jwt = new JwtTokens(key);
  }
  async create(userId: number, remember: boolean) {
    const { token, expiresAt, ttl } = await this.jwt.issue(userId, remember);
    const csrfToken = randomBytes(32).toString('hex');
    await this.db.query('DELETE FROM app_session WHERE expires_at <= NOW()');
    await this.db.query(
      'INSERT INTO app_session (token_hash,userid,csrf_token,expires_at) VALUES ($1,$2,$3,$4)',
      [tokenHash(token), userId, csrfToken, expiresAt],
    );
    return { token, csrfToken, ttl };
  }
  async find(token: string) {
    const claims = await this.jwt.verify(token);
    if (!claims) return null;
    // The JWT must be valid AND still issued/not revoked. Binding sub to userid
    // prevents a row/identity mismatch; deleting the row invalidates it at once.
    const { rows } = await this.db.query<{ userId: number; csrfToken: string }>(
      'SELECT userid AS "userId",csrf_token AS "csrfToken" FROM app_session WHERE token_hash=$1 AND userid=$2 AND expires_at>NOW()',
      [tokenHash(token), claims.userId],
    );
    return rows[0] ?? null;
  }
  async remove(token: string) {
    await this.db.query('DELETE FROM app_session WHERE token_hash=$1', [
      tokenHash(token),
    ]);
  }
}
