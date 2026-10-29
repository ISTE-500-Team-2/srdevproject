import { confirmationToken } from '../helpers/confirmation.js';
import { issueEmailConfirmation } from '../../src/confirmation/emailConfirmation.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { consumePasswordReset } from '../../src/confirmation/passwordReset.js';
import { updateNotificationPreferences } from '../../src/notifications/store.js';
import { runNotificationBatch } from '../../src/notifications/worker.js';

const database = 'arbor_reset_' + randomBytes(6).toString('hex') + '_mvc_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
const config = { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
  demoLogin: false, allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York' };
let app: ReturnType<typeof createApp>;
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PG required');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
});
beforeEach(async () => { app = createApp(pool, config); await pool.query('DELETE FROM app_notification_outbox'); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });
async function person(name: string) {
  const input = { email: `${name}@example.invalid`, username: name, password: 'OldPassword!',
    firstName: 'Reset', lastName: 'Test', dob: '2000-01-01', phone: '0000000000' };
  const response = await request(app).post('/api/auth/register').send(input);
  assert.equal(response.status, 202);
  // Password recovery fixtures are verified members; pending requests cannot reset into an account.
  assert.equal((await request(app).post('/api/auth/confirm').send({token:await confirmationToken(pool,input.email)})).status,200);
  const id = (await pool.query('SELECT userid FROM "user" WHERE email=$1', [input.email])).rows[0].userid;
  return { ...input, id };
}
const ask = (email: string) => request(app).post('/api/auth/password-reset').send({ email });
const check = (token: string) => request(app).post('/api/auth/password-reset/check').send({ token });
const confirm = (token: string, password = 'NewPassword!') => request(app).post('/api/auth/password-reset/confirm').send({ token, password });
async function link(id: number) {
  const row = (await pool.query("SELECT payload FROM app_notification_outbox WHERE userid=$1 AND kind='password_reset' ORDER BY id DESC LIMIT 1", [id])).rows[0];
  assert.ok(row, 'reset email queued');
  return new URL(row.payload.resetUrl as string);
}
async function tokenFor(id: number) { return (await link(id)).hash.slice(1); }

test('request is neutral for known, unknown, inactive, opted-out and throttled accounts; validates email', async () => {
  const known = await person('neutral');
  await updateNotificationPreferences(pool, known.id, { enabled: false, timeZone: 'America/New_York' });
  const active = await ask(known.email);
  assert.equal(active.status, 202);
  const url = await link(known.id);
  assert.equal(url.pathname, '/reset-password'); assert.equal(url.search, '');
  assert.match(url.hash, /^#[A-Za-z0-9_-]{43}$/);
  const row = (await pool.query('SELECT * FROM app_password_reset WHERE userid=$1', [known.id])).rows[0];
  assert.equal(row.token_hash, createHash('sha256').update(url.hash.slice(1)).digest('hex'));
  assert.ok(Math.abs(row.expires_at.getTime() - row.created_at.getTime() - 1800000) < 2000);
  assert.deepEqual((await ask('unknown@example.invalid')).body, active.body);
  assert.deepEqual((await ask(known.email)).body, active.body);
  assert.equal(await tokenFor(known.id), url.hash.slice(1));
  assert.equal((await pool.query("SELECT status FROM app_notification_outbox WHERE kind='password_reset'")).rows[0].status, 'pending');
  await pool.query('UPDATE "user" SET status=$2 WHERE userid=$1', [known.id, 'inactive']);
  assert.deepEqual((await ask(known.email)).body, active.body);
  const bad = await ask('not-an-email'); assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'INVALID_INPUT');
});

test('check is non-consuming; resend replaces the token after one minute; expired, malformed and inactive links fail', async () => {
  const user = await person('checks'); await ask(user.email); const old = await tokenFor(user.id);
  assert.equal((await check(old)).status, 204); assert.equal((await check(old)).status, 204);
  await pool.query("UPDATE app_password_reset SET created_at=NOW()-INTERVAL '61 seconds' WHERE userid=$1", [user.id]);
  await ask(user.email); const next = await tokenFor(user.id); assert.notEqual(next, old);
  assert.equal((await check(old)).body.error.code, 'RESET_INVALID');
  assert.equal((await check(next)).status, 204);
  await pool.query('UPDATE "user" SET status=$2 WHERE userid=$1', [user.id, 'inactive']);
  assert.equal((await check(next)).status, 400); assert.equal((await confirm(next)).status, 400);
  await pool.query('UPDATE "user" SET status=$2 WHERE userid=$1', [user.id, 'active']);
  await pool.query('UPDATE app_password_reset SET expires_at=NOW() WHERE userid=$1', [user.id]);
  assert.equal((await check(next)).status, 400); assert.equal((await confirm(next)).body.error.code, 'RESET_INVALID');
  assert.equal((await check('bad')).status, 400);
  assert.equal((await check('z'.repeat(43))).status, 400);
});

test('password validation errors preserve the token, including the 72-byte bcrypt limit', async () => {
  const user = await person('validation'); await ask(user.email); const token = await tokenFor(user.id);
  for (const password of ['short', 'lowercase!', 'NoSpecialCharacter', 'A!'.repeat(65)]) {
    const result = await confirm(token, password); assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_INPUT');
  }
  for (const password of ['A!' + 'b'.repeat(71), 'A!' + 'é'.repeat(36)]) {
    const result = await confirm(token, password); assert.equal(result.status, 400); assert.equal(result.body.error.code, 'PASSWORD_TOO_LONG');
    assert.match(result.body.error.message, /72 UTF-8 bytes/);
    assert.equal((await check(token)).status, 204);
  }
  assert.equal((await confirm(token)).status, 204);
});

test('reset confirms email, changes the password, revokes access and refresh sessions, and is single-use under concurrency', async () => {
  const user = await person('sessions');
  await pool.query('UPDATE "user" SET email_confirmed=true WHERE userid=$1', [user.id]);
  const older = await request(app).post('/api/auth/login').send(user);
  const second = await request(app).post('/api/auth/login').send({ ...user, remember: true });
  assert.equal(older.status, 200); assert.equal(second.status, 200);
  await pool.query('UPDATE "user" SET email_confirmed=false WHERE userid=$1', [user.id]);
  await updateNotificationPreferences(pool, user.id, { enabled: false, timeZone: 'America/New_York' });
  await ask(user.email); const token = await tokenFor(user.id);
  const responses = await Promise.all([confirm(token), confirm(token)]);
  assert.deepEqual(responses.map(x => x.status).sort(), [204, 400]);
  assert.equal((await pool.query('SELECT email_confirmed FROM "user" WHERE userid=$1', [user.id])).rows[0].email_confirmed, true);
  assert.equal((await pool.query('SELECT 1 FROM app_session WHERE userid=$1', [user.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM app_refresh_family WHERE userid=$1 AND NOT revoked', [user.id])).rowCount, 0);
  for (const prior of [older, second]) {
    assert.equal((await request(app).get('/api/auth/session').set('Authorization', `Bearer ${prior.body.data.accessToken}`)).status, 401);
    const cookies = prior.headers['set-cookie'];
    assert.ok(cookies);
    assert.equal((await request(app).post('/api/auth/refresh').set('Cookie', cookies)
      .set('X-CSRF-Token', prior.body.data.csrfToken).send({})).status, 401);
  }
  assert.equal((await request(app).post('/api/auth/login').send(user)).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ ...user, password: 'NewPassword!' })).status, 200);
  assert.equal((await check(token)).status, 400);
  const mail = (await pool.query("SELECT status FROM app_notification_outbox WHERE userid=$1 AND kind='password_changed'", [user.id])).rows;
  assert.deepEqual(mail.map(r => r.status), ['pending']);
  assert.equal((await pool.query('SELECT 1 FROM app_email_confirmation WHERE userid=$1', [user.id])).rowCount, 0);
});

test('both security emails survive opt-out before queue, after queue, and at dispatch; stale reset mail is obsolete', async () => {
  const user = await person('securitymail');
  await updateNotificationPreferences(pool, user.id, { enabled: false, timeZone: 'America/New_York' });
  await ask(user.email); const old = await tokenFor(user.id);
  await updateNotificationPreferences(pool, user.id, { enabled: false, timeZone: 'America/New_York' });
  const sent: string[] = [];
  const send = async (row: { kind: string; id: number }) => { sent.push(row.kind); return { messageId: `local-test-${row.id}` }; };
  await runNotificationBatch(pool, send);
  assert.deepEqual(sent, ['password_reset']);
  await pool.query("UPDATE app_password_reset SET created_at=NOW()-INTERVAL '61 seconds' WHERE userid=$1", [user.id]);
  await ask(user.email); const next = await tokenFor(user.id);
  await pool.query("UPDATE app_notification_outbox SET status='pending' WHERE kind='password_reset' AND payload->>'resetHash'=$1", [createHash('sha256').update(old).digest('hex')]);
  const stale = await runNotificationBatch(pool, send);
  assert.equal(stale.obsolete, 1); assert.deepEqual(sent, ['password_reset', 'password_reset']);
  await confirm(next);
  await updateNotificationPreferences(pool, user.id, { enabled: false, timeZone: 'America/New_York' });
  await runNotificationBatch(pool, send);
  assert.deepEqual(sent, ['password_reset', 'password_reset', 'password_changed']);
});

test('a failed outbox insert rolls back password, session revocation and token consumption', async () => {
  const user = await person('rollback'); await ask(user.email); const token = await tokenFor(user.id);
  const before = (await pool.query('SELECT password FROM "user" WHERE userid=$1', [user.id])).rows[0].password;
  await pool.query(`CREATE FUNCTION reject_reset_notice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind='password_changed' THEN RAISE EXCEPTION 'test notice failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_reset_notice BEFORE INSERT ON app_notification_outbox FOR EACH ROW EXECUTE FUNCTION reject_reset_notice()`);
  try { assert.equal((await confirm(token)).status, 500); }
  finally { await pool.query('DROP TRIGGER reject_reset_notice ON app_notification_outbox; DROP FUNCTION reject_reset_notice()'); }
  assert.equal((await check(token)).status, 204);
  assert.equal((await pool.query('SELECT password FROM "user" WHERE userid=$1', [user.id])).rows[0].password, before);
});

test('changing an unconfirmed email invalidates reset links sent to the previous inbox', async () => {
  // Exercise the legacy unverified-account path separately from staged public registration.
  const user = await person('changeemail');
  await pool.query('UPDATE "user" SET email_confirmed=false WHERE userid=$1',[user.id]);
  await issueEmailConfirmation(pool,user.id,'http://localhost:8080');
  await ask(user.email); const token = await tokenFor(user.id);
  await pool.query("UPDATE app_email_confirmation SET created_at=NOW()-INTERVAL '61 seconds' WHERE userid=$1", [user.id]);
  const result = await request(app).post('/api/auth/confirmation').send({ ...user, newEmail: 'changed@example.invalid' });
  assert.equal(result.status, 202); assert.equal((await check(token)).status, 400);
});

test('a login verified with the old password cannot create a session after reset wins the account lock', async () => {
  const user = await person('loginrace');
  await pool.query('UPDATE "user" SET email_confirmed=true WHERE userid=$1', [user.id]);
  await ask(user.email); const token = await tokenFor(user.id);
  const blocker = await pool.connect();
  await blocker.query('BEGIN'); await blocker.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [user.id]);
  const login = request(app).post('/api/auth/login').send(user).then(response => response);
  try {
    let waiting = false;
    for (let i = 0; i < 250; i++) {
      waiting = !!(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1
        AND wait_event_type='Lock' AND query LIKE '%SELECT password FROM%FOR SHARE%'`, [database])).rowCount;
      if (waiting) break;
      await delay(20);
    }
    assert.ok(waiting, 'login reached the account lock after verifying the old password');
    await consumePasswordReset(blocker, token, 'NewPassword!'); await blocker.query('COMMIT');
    assert.equal((await login).status, 401);
    assert.equal((await pool.query('SELECT 1 FROM app_session WHERE userid=$1', [user.id])).rowCount, 0);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await login; }
});

test('all three public reset routes share the existing authentication throttle', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await check('bad')).status, 400);
  for (const response of [await ask('unknown@example.invalid'), await check('bad'), await confirm('bad')]) {
    assert.equal(response.status, 429); assert.equal(response.body.error.code, 'RATE_LIMITED'); assert.ok(response.headers['retry-after']);
  }
});

test('concurrent correct legacy logins both succeed when only one bcrypt upgrade wins', async () => {
  const user = await person('legacyrace');
  const salt = randomBytes(16).toString('hex');
  const legacy = 'scrypt$' + salt + '$' + scryptSync(user.password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('hex');
  await pool.query('UPDATE "user" SET password=$2,email_confirmed=true WHERE userid=$1', [user.id, legacy]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN'); await blocker.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [user.id]);
  const logins = Promise.all([1, 2].map(() => request(app).post('/api/auth/login').send(user)));
  try {
    let waiting = 0;
    for (let i = 0; i < 250; i++) {
      waiting = (await pool.query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1
        AND wait_event_type='Lock' AND query LIKE '%UPDATE "user" SET password=%AND password=%'`, [database])).rows[0].n;
      if (waiting === 2) break;
      await delay(20);
    }
    assert.equal(waiting, 2, 'both logins verified the legacy password and reached the upgrade');
    await blocker.query('COMMIT');
    assert.deepEqual((await logins).map(response => response.status), [200, 200]);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await logins; }
});
