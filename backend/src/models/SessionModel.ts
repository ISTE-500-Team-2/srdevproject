import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { timingSafeEqual } from 'node:crypto';
import { UserModel } from './UserModel.js';
import { JwtTokens, rememberedLifetimeSeconds } from '../jwt.js';

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export class SessionModel {
  private jwt: JwtTokens;
  constructor(private db: Database, key: Uint8Array, accessSeconds?: number, private refreshSeconds = rememberedLifetimeSeconds) {
    this.jwt = new JwtTokens(key, accessSeconds);
  }
  async create(userId: number, remember: boolean) {
    await this.db.query('DELETE FROM app_session WHERE expires_at<=NOW()');
    await this.db.query('DELETE FROM app_refresh_family WHERE expires_at<=NOW()');
    const familyId = randomUUID(), csrfToken = randomBytes(32).toString('hex');
    await this.db.query(`INSERT INTO app_refresh_family(id,userid,csrf_token,expires_at,persistent) VALUES($1,$2,$3,NOW()+$4*INTERVAL '1 second',$5)`, [familyId,userId,csrfToken,this.refreshSeconds,remember]);
    return this.issue(userId, familyId, csrfToken, remember);
  }
  private async issue(userId: number, familyId: string, csrfToken: string, persistent: boolean) {
    const user = await new UserModel(this.db).findById(userId);
    if (!user || user.status !== 'active') throw new Error('Inactive refresh account');
    const {token, expiresAt, ttl} = await this.jwt.issue(userId, user.role, user.roles);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.query('INSERT INTO app_refresh_token(token_hash,family_id) VALUES($1,$2)',[tokenHash(refreshToken),familyId]);
    await this.db.query('INSERT INTO app_session(token_hash,userid,csrf_token,expires_at,family_id) VALUES($1,$2,$3,$4,$5)',[tokenHash(token),userId,csrfToken,expiresAt,familyId]);
    return {token,refreshToken,csrfToken,ttl,user,persistent};
  }
  async refreshCsrf(refreshToken: string) {
    const {rows} = await this.db.query(`SELECT f.csrf_token AS "csrfToken" FROM app_refresh_token t JOIN app_refresh_family f ON f.id=t.family_id WHERE t.token_hash=$1 AND NOT t.consumed AND NOT f.revoked AND f.expires_at>NOW()`,[tokenHash(refreshToken)]);
    return rows[0]?.csrfToken as string | undefined;
  }
  // Caller wraps rotation in a transaction. Lock family first, then reread consumption
  // so concurrent reuse is detected rather than issuing two successors.
  async rotate(refreshToken: string, csrf: string) {
    const {rows} = await this.db.query(`SELECT f.* FROM app_refresh_family f JOIN app_refresh_token t ON t.family_id=f.id WHERE t.token_hash=$1 FOR UPDATE OF f`,[tokenHash(refreshToken)]);
    const family = rows[0];
    if (!family || family.revoked || new Date(family.expires_at).getTime() <= Date.now()) return null;
    const expected = Buffer.from(family.csrf_token), actual = Buffer.from(csrf);
    if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) return null;
    const current = (await this.db.query('SELECT consumed FROM app_refresh_token WHERE token_hash=$1',[tokenHash(refreshToken)])).rows[0];
    const user = await new UserModel(this.db).findById(family.userid);
    if (current?.consumed || !user || user.status !== 'active') {
      await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=$1',[family.id]);
      return null; // Return, not throw: replay revocation must commit.
    }
    await this.db.query('UPDATE app_refresh_token SET consumed=true WHERE token_hash=$1',[tokenHash(refreshToken)]);
    return this.issue(family.userid, family.id, family.csrf_token, family.persistent);
  }
  async revokeRefresh(refreshToken: string) {
    await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=(SELECT family_id FROM app_refresh_token WHERE token_hash=$1)',[tokenHash(refreshToken)]);
  }
  async find(token: string) {
    const claims = await this.jwt.verify(token);
    if (!claims) return null;
    // The JWT must be valid AND still issued/not revoked. Binding sub to userid
    // prevents a row/identity mismatch; deleting the row invalidates it at once.
    const { rows } = await this.db.query<{ userId: number; csrfToken: string }>(
      'SELECT userid AS "userId",csrf_token AS "csrfToken" FROM app_session WHERE token_hash=$1 AND userid=$2 AND expires_at>NOW() AND family_id IN (SELECT id FROM app_refresh_family WHERE NOT revoked AND expires_at>NOW())',
      [tokenHash(token), claims.userId],
    );
    return rows[0] ?? null;
  }
  async remove(token: string) {
    await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=(SELECT family_id FROM app_session WHERE token_hash=$1)', [
      tokenHash(token),
    ]);
  }
}
