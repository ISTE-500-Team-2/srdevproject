import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { timingSafeEqual } from 'node:crypto';
import { UserModel } from './UserModel.js';
import { AppError, type UserView } from '../domain.js';
import { browserSessionLifetimeSeconds, JwtTokens, rememberedLifetimeSeconds } from '../jwt.js';

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** A signed-in session as returned to the auth controller. */
export interface IssuedSession {
  token: string; refreshToken: string; csrfToken: string; ttl: number; user: UserView; persistent: boolean;
}
/** The validated session behind an access token. */
export interface ActiveSession { userId: number; csrfToken: string; actingAsUserId: number | null }
interface RefreshFamilyRow {
  id: string; userid: number; csrf_token: string; expires_at: Date; revoked: boolean; persistent: boolean;
}

export class SessionModel {
  private jwt: JwtTokens;
  constructor(private db: Database, key: Uint8Array, accessSeconds?: number, private refreshSeconds = rememberedLifetimeSeconds, private timeZone = "America/New_York") {
    this.jwt = new JwtTokens(key, accessSeconds);
  }
  async create(userId: number, remember: boolean): Promise<IssuedSession> {
    await this.db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [userId]);
    await this.db.query('DELETE FROM app_session WHERE expires_at<=NOW()');
    await this.db.query('DELETE FROM app_refresh_family WHERE expires_at<=NOW()');
    const familyId = randomUUID(), csrfToken = randomBytes(32).toString('hex');
    // Shared makerspace computers: without Remember me, sign-in ends within hours even if the browser restores its session cookies.
    const lifetime = remember ? this.refreshSeconds : Math.min(this.refreshSeconds, browserSessionLifetimeSeconds);
    await this.db.query(`INSERT INTO app_refresh_family(id,userid,csrf_token,expires_at,persistent) VALUES($1,$2,$3,NOW()+$4*INTERVAL '1 second',$5)`, [familyId,userId,csrfToken,lifetime,remember]);
    return this.issue(userId, familyId, csrfToken, remember);
  }
  private async issue(userId: number, familyId: string, csrfToken: string, persistent: boolean): Promise<IssuedSession> {
    const user = await new UserModel(this.db, this.timeZone).findById(userId);
    if (!user || user.status !== 'active' || user.accessStatus !== 'active') throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account does not currently have access. Please see staff.');
    const {token, expiresAt, ttl} = await this.jwt.issue(userId, user.roles.includes(user.primaryRole ?? "") ? user.primaryRole! : user.roles[0] ?? user.role, user.roles);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.query('INSERT INTO app_refresh_token(token_hash,family_id) VALUES($1,$2)',[tokenHash(refreshToken),familyId]);
    await this.db.query('INSERT INTO app_session(token_hash,userid,csrf_token,expires_at,family_id) VALUES($1,$2,$3,$4,$5)',[tokenHash(token),userId,csrfToken,expiresAt,familyId]);
    return {token,refreshToken,csrfToken,ttl,user,persistent};
  }
  async refreshCsrf(refreshToken: string): Promise<string | undefined> {
    const {rows} = await this.db.query<{ csrfToken: string }>(`SELECT f.csrf_token AS "csrfToken" FROM app_refresh_token t JOIN app_refresh_family f ON f.id=t.family_id WHERE t.token_hash=$1 AND NOT t.consumed AND NOT f.revoked AND f.expires_at>NOW()`,[tokenHash(refreshToken)]);
    return rows[0]?.csrfToken;
  }
  // Caller wraps rotation in a transaction. Lock user before family, matching
  // account status changes; then reread consumption to detect concurrent reuse.
  async rotate(refreshToken: string, csrf: string): Promise<IssuedSession | null> {
    const owner = (await this.db.query<{ userid: number }>('SELECT f.userid FROM app_refresh_family f JOIN app_refresh_token t ON t.family_id=f.id WHERE t.token_hash=$1', [tokenHash(refreshToken)])).rows[0];
    if (!owner) return null;
    await this.db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [owner.userid]);
    const {rows} = await this.db.query<RefreshFamilyRow>(`SELECT f.id,f.userid,f.csrf_token,f.expires_at,f.revoked,f.persistent FROM app_refresh_family f JOIN app_refresh_token t ON t.family_id=f.id WHERE t.token_hash=$1 FOR UPDATE OF f`,[tokenHash(refreshToken)]);
    const family = rows[0];
    if (!family || family.revoked || new Date(family.expires_at).getTime() <= Date.now()) return null;
    const expected = Buffer.from(family.csrf_token), actual = Buffer.from(csrf);
    if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) return null;
    const current = (await this.db.query<{ consumed: boolean }>('SELECT consumed FROM app_refresh_token WHERE token_hash=$1',[tokenHash(refreshToken)])).rows[0];
    const user = await new UserModel(this.db, this.timeZone).findById(family.userid);
    if (current?.consumed || !user || user.status !== 'active' || user.accessStatus !== 'active') {
      await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=$1',[family.id]);
      return null; // Return, not throw: replay revocation must commit.
    }
    // Refresh bypasses requireUser; bind the verified owner on this transaction
    // before token consumption and successor creation fire their audit triggers.
    await this.db.query("SELECT set_config('app.actor_id',$1,true)",[String(user.id)]);
    await this.db.query('UPDATE app_refresh_token SET consumed=true WHERE token_hash=$1',[tokenHash(refreshToken)]);
    return this.issue(family.userid, family.id, family.csrf_token, family.persistent);
  }
  async revokeRefresh(refreshToken: string) {
    await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=(SELECT family_id FROM app_refresh_token WHERE token_hash=$1)',[tokenHash(refreshToken)]);
  }
  async find(token: string): Promise<ActiveSession | null> {
    const claims = await this.jwt.verify(token);
    if (!claims) return null;
    // The JWT must be valid AND still issued/not revoked. Binding sub to userid
    // prevents a row/identity mismatch; deleting the row invalidates it at once.
    const { rows } = await this.db.query<ActiveSession>(
      'SELECT s.userid AS "userId",s.csrf_token AS "csrfToken",f.acting_as_userid AS "actingAsUserId" FROM app_session s JOIN app_refresh_family f ON f.id=s.family_id WHERE s.token_hash=$1 AND s.userid=$2 AND s.expires_at>NOW() AND NOT f.revoked AND f.expires_at>NOW()',
      [tokenHash(token), claims.userId],
    );
    return rows[0] ?? null;
  }
  /** Open (or with null, close) a member's account for this sign-in. */
  async setActingAs(token: string, userId: number | null) {
    await this.db.query('UPDATE app_refresh_family SET acting_as_userid=$2 WHERE id=(SELECT family_id FROM app_session WHERE token_hash=$1)', [tokenHash(token), userId]);
  }
  async remove(token: string) {
    await this.db.query('UPDATE app_refresh_family SET revoked=true WHERE id=(SELECT family_id FROM app_session WHERE token_hash=$1)', [
      tokenHash(token),
    ]);
  }
}
