import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { before, after, test } from 'node:test';
import { decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { cookieName } from '../../src/middleware/auth.js';
import { jwtIssuer, jwtAudience, sessionLifetimeSeconds, rememberedLifetimeSeconds } from '../../src/jwt.js';
import { tokenHash } from '../../src/models/SessionModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_jwt_' + randomBytes(6).toString('hex') + '_mvc_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
const config: AppConfig = {
  port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York',
  jwtKey: randomBytes(64),
};
let app: ReturnType<typeof createApp>;
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error('Explicit isolated PostgreSQL configuration required.');
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  app = createApp(pool, config);
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

function browserToken(res: request.Response) {
  return res.body.data.accessToken as string;
}
function current(token: string, instance = app) {
  return request(instance).get('/api/auth/session').set('Authorization', `Bearer ${token}`);
}
async function register() {
  const email = randomUUID() + '@example.invalid';
  const password = randomBytes(24).toString('hex');
  const res = await request(app).post('/api/auth/register').send({
    email, password, firstName: 'JWT', lastName: 'Test', phone: '0000000000',
  });
  assert.equal(res.status, 201);
  return { email, password, userId: res.body.data.user.id as number, token: browserToken(res), csrf: res.body.data.csrfToken as string, res };
}
function claims(userId: number): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { sub: String(userId), iss: jwtIssuer, aud: jwtAudience, jti: randomUUID(), iat: now, nbf: now, exp: now + 900, role:'member', roles:['member'] };
}
function signed(payload: JWTPayload, key = config.jwtKey, alg = 'HS256', typ = 'JWT') {
  return new SignJWT(payload).setProtectedHeader({ alg, typ }).sign(key);
}
async function track(token: string, userId: number) {
  // Keep even invalid test JWTs in the registry, with a live DB expiry, to
  // prove rejection is caused by JWT verification and not a missing hash.
  await pool.query(
    `INSERT INTO app_session(token_hash,userid,csrf_token,expires_at,family_id) VALUES($1,$2,$3,NOW()+INTERVAL '8 days',(SELECT id FROM app_refresh_family WHERE userid=$2 AND NOT revoked LIMIT 1))`,
    [tokenHash(token), userId, randomBytes(32).toString('hex')],
  );
}

test('registration and remembered login issue signed JWTs with bounded expiry and protected cookies', async () => {
  const account = await register();
  const verified = await jwtVerify(account.token, config.jwtKey, { algorithms: ['HS256'], issuer: jwtIssuer, audience: jwtAudience });
  assert.equal(decodeProtectedHeader(account.token).typ, 'JWT');
  assert.equal(verified.payload.sub, String(account.userId));
  assert.equal(verified.payload.exp! - verified.payload.iat!, sessionLifetimeSeconds);
  assert.equal(typeof verified.payload.jti, 'string');
  assert.deepEqual(verified.payload.roles, ['member']);
  assert.equal(verified.payload.role, 'member');
  assert.equal('email' in verified.payload, false);
  const cookie = account.res.headers['set-cookie'].find((c:string)=>c.startsWith(cookieName+'='))!;
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Path=/api'));
  assert.equal(cookie.includes('Max-Age'), false);
  const remembered = await request(app).post('/api/auth/login').send({ email: account.email, password: account.password, remember: true });
  assert.equal(remembered.status, 200);
  const payload = (await jwtVerify(browserToken(remembered), config.jwtKey)).payload;
  assert.equal(payload.exp! - payload.iat!, sessionLifetimeSeconds);
  assert.ok(remembered.headers['set-cookie'].find((c:string)=>c.startsWith(cookieName+'='))!.includes(`Max-Age=${rememberedLifetimeSeconds}`));
  const secure = await request(createApp(pool, { ...config, secureCookies: true })).post('/api/auth/login').send({ email: account.email, password: account.password });
  assert.ok(secure.headers['set-cookie'].find((c:string)=>c.startsWith(cookieName+'='))!.includes('Secure'));
  const stored = await pool.query('SELECT token_hash,expires_at FROM app_session WHERE token_hash=$1', [tokenHash(account.token)]);
  assert.equal(stored.rows[0].token_hash.length, 64);
  assert.equal(new Date(stored.rows[0].expires_at).getTime(), verified.payload.exp! * 1000);
});

test('invalid signatures, algorithms, identity/expiry claims and old opaque tokens fail even with live DB rows', async () => {
  const account = await register();
  const valid = await signed(claims(account.userId));
  await track(valid, account.userId);
  assert.equal((await current(valid)).status, 200);
  const base = claims(account.userId);
  const cases: [string, string][] = [
    ['wrong signing key', await signed(base, randomBytes(32))],
    ['wrong algorithm', await signed(base, config.jwtKey, 'HS384')],
    ['wrong token type', await signed(base, config.jwtKey, 'HS256', 'other+jwt')],
    ['tampered payload', valid.split('.').map((part, i) => i === 1 ? Buffer.from(JSON.stringify({ ...decodeJwt(valid), sub: '999' })).toString('base64url') : part).join('.')],
    ['unsigned token', Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(base)).toString('base64url') + '.'],
    ['expired JWT', await signed({ ...base, iat: base.iat! - 7200, nbf: base.nbf! - 7200, exp: base.iat! - 60 })],
    ['not active yet', await signed({ ...base, nbf: base.iat! + 600 })],
    ['future issue time', await signed({ ...base, iat: base.iat! + 600 })],
    ['wrong issuer', await signed({ ...base, iss: 'another-app' })],
    ['wrong audience', await signed({ ...base, aud: 'another-api' })],
    ['invalid subject', await signed({ ...base, sub: '-1' })],
    ['non-string subject', await signed({ ...base, sub: account.userId as unknown as string })],
    ['unsafe numeric subject', await signed({ ...base, sub: '9007199254740992' })],
    ['invalid token identifier', await signed({ ...base, jti: '' })],
    ['excessive lifetime', await signed({ ...base, exp: base.iat! + rememberedLifetimeSeconds + 1 })],
    ['old opaque token', randomBytes(32).toString('base64url')],
    ['malformed JWT', 'invalid.jwt.value'],
  ];
  for (const name of ['exp', 'nbf', 'iat', 'sub', 'jti', 'iss', 'aud', 'role', 'roles']) {
    const missing = { ...base };
    delete missing[name];
    cases.push(['missing ' + name, await signed(missing)]);
  }
  for (const [label, token] of cases) {
    await track(token, account.userId);
    const result = await current(token);
    assert.equal(result.status, 401, label);
    assert.equal(result.body.error.code, 'UNAUTHENTICATED', label);
  }
});

test('logout revokes a captured JWT, and re-login rotates the previous JWT and CSRF token', async () => {
  const account = await register();
  const signedIn = await request(app).post('/api/auth/login')
    .set('Cookie', account.res.headers['set-cookie'].find((c:string)=>c.startsWith(cookieName+'='))!.split(';')[0])
    .send({ email: account.email, password: account.password });
  assert.equal(signedIn.status, 200);
  const token = browserToken(signedIn);
  assert.ok(token !== account.token, 'new login must issue a unique token');
  assert.ok(signedIn.body.data.csrfToken !== account.csrf, 'CSRF token must rotate');
  assert.equal((await current(account.token)).status, 401);
  assert.equal((await current(token)).status, 200);
  const logout = await request(app).post('/api/auth/logout')
    .set('Authorization', `Bearer ${token}`)
    .set('X-CSRF-Token', signedIn.body.data.csrfToken).send({});
  assert.equal(logout.status, 204);
  assert.equal((await current(token)).status, 401, 'captured token must not work after logout');
});

test('JWT subject is bound to the registry account, roles/status are live, and unissued JWTs fail', async () => {
  const account = await register();
  const unissued = await signed(claims(account.userId));
  assert.equal((await current(unissued)).status, 401);
  const privilegedClaim = await signed({ ...claims(account.userId), role: 'admin', roles: ['admin'] });
  await track(privilegedClaim, account.userId);
  const result = await current(privilegedClaim);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.user.role, 'member');
  assert.equal((await request(app).get('/api/admin/users').set('Authorization', `Bearer ${privilegedClaim}`)).status, 403);
  await pool.query("UPDATE \"user\" SET status='inactive' WHERE userid=$1", [account.userId]);
  assert.equal((await current(account.token)).status, 403);
  const other = await register();
  const mismatch = await signed(claims(account.userId));
  await track(mismatch, other.userId);
  assert.equal((await current(mismatch)).status, 401);
});

test('valid JWTs retain CSRF and Origin enforcement on writes', async () => {
  const account = await register();
  const logout = (csrf?: string, origin = 'http://localhost:8080') => {
    let call = request(app).post('/api/auth/logout').set('Authorization', `Bearer ${account.token}`).set('Origin', origin);
    if (csrf) call = call.set('X-CSRF-Token', csrf);
    return call.send({});
  };
  assert.equal((await logout()).status, 403);
  assert.equal((await logout(randomBytes(32).toString('hex'))).status, 403);
  assert.equal((await logout(account.csrf, 'https://untrusted.example')).status, 403);
  assert.equal((await current(account.token)).status, 200);
  assert.equal((await logout(account.csrf)).status, 204);
});

test('same key survives app restart; a rotated signing key and expired registry entry invalidate JWTs', async () => {
  const account = await register();
  assert.equal((await current(account.token, createApp(pool, config))).status, 200);
  assert.equal((await current(account.token, createApp(pool, { ...config, jwtKey: randomBytes(32) }))).status, 401);
  await pool.query("UPDATE app_session SET expires_at=NOW()-INTERVAL '1 minute' WHERE token_hash=$1", [tokenHash(account.token)]);
  assert.equal((await current(account.token)).status, 401);
});

function refreshCookie(res: request.Response) { return res.headers['set-cookie'].find((c:string)=>c.startsWith(cookieName+'='))!.split(';')[0]!; }
function renew(cookie: string, csrf: string) { return request(app).post('/api/auth/refresh').set('Cookie',cookie).set('X-CSRF-Token',csrf).send({}); }
test('refresh rotates once; replay commits family revocation for old and new access tokens', async () => {
  const a = await register(), cookie=refreshCookie(a.res);
  assert.equal((await request(app).get('/api/auth/session').set('Cookie',cookie)).status,401,'refresh cookie is not an access credential');
  const refreshed = await renew(cookie,a.csrf);
  assert.equal(refreshed.status,200);
  assert.notEqual(refreshCookie(refreshed),cookie);
  assert.equal((await current(browserToken(refreshed))).status,200);
  assert.equal((await renew(cookie,a.csrf)).status,401);
  assert.equal((await current(browserToken(refreshed))).status,401);
  assert.equal((await renew(refreshCookie(refreshed),a.csrf)).status,401);
});
test('refresh rejects missing CSRF, bad origin, expiration and inactive account', async () => {
  const a=await register(), cookie=refreshCookie(a.res);
  assert.equal((await renew(cookie,'')).status,401);
  assert.equal((await request(app).post('/api/auth/refresh').set('Cookie',cookie).set('X-CSRF-Token',a.csrf).set('Origin','https://untrusted.example').send({})).status,403);
  await pool.query("UPDATE app_refresh_family SET expires_at=NOW()-INTERVAL '1 minute' WHERE userid=$1",[a.userId]);
  assert.equal((await renew(cookie,a.csrf)).status,401);
  const b=await register();
  await pool.query(`UPDATE "user" SET status='inactive' WHERE userid=$1`,[b.userId]);
  assert.equal((await renew(refreshCookie(b.res),b.csrf)).status,401);
});
test('concurrent refresh reuse cannot issue two valid successors', async () => {
  const a=await register(), cookie=refreshCookie(a.res);
  const results=await Promise.all([renew(cookie,a.csrf),renew(cookie,a.csrf)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const success=results.find(r=>r.status===200)!;
  assert.equal((await current(browserToken(success))).status,401);
});
test('refresh reloads role claims and logout revokes refresh as well as access', async () => {
  const a=await register();
  await pool.query(`UPDATE user_role SET roleid=(SELECT roleid FROM role WHERE role='staff') WHERE userid=$1`,[a.userId]);
  const renewed=await renew(refreshCookie(a.res),a.csrf);
  assert.equal(renewed.status,200);
  assert.equal(decodeJwt(browserToken(renewed)).role,'staff');
  const ended=await request(app).post('/api/auth/logout').set('Authorization','Bearer '+browserToken(renewed)).set('X-CSRF-Token',a.csrf).send({});
  assert.equal(ended.status,204);
  assert.equal((await renew(refreshCookie(renewed),a.csrf)).status,401);
});

test('legacy scrypt credentials upgrade after successful login; configurable expiry is honored', async () => {
  const a=await register(), salt=randomBytes(16).toString('hex');
  const legacy='scrypt$'+salt+'$'+scryptSync(a.password,salt,64,{N:32768,r:8,p:1,maxmem:67108864}).toString('hex');
  await pool.query('UPDATE "user" SET password=$1 WHERE userid=$2',[legacy,a.userId]);
  const custom=createApp(pool,{...config,accessTokenSeconds:60,refreshTokenSeconds:3600});
  const login=await request(custom).post('/api/auth/login').send({email:a.email,password:a.password,remember:true});
  assert.equal(login.status,200);
  const claims=decodeJwt(browserToken(login));
  assert.equal(claims.exp!-claims.iat!,60);
  assert.match((await pool.query('SELECT password FROM "user" WHERE userid=$1',[a.userId])).rows[0].password,/^\$2b\$12\$/);
  assert.ok(login.headers['set-cookie'].some((c:string)=>c.includes('Max-Age=3600')));
});
