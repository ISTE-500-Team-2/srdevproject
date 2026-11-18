import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';

// Production reaches the app through one proxy (TRUST_PROXY=1). Sign-in limits must count each
// visitor: a stranger's failed attempts, or a busy class signing in, must not lock out everyone.
const database = 'arbor_auth_limits_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const config = { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York' };
const member = { firstName: 'Limit', lastName: 'Test', email: 'limits@example.invalid', phone: '0000000000',
  dob: '2000-01-01', password: 'ValidPassword!' };
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PG required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  const app = createApp(pool, config);
  assert.equal((await request(app).post('/api/auth/register').send(member)).status, 202);
  assert.equal((await request(app).post('/api/auth/confirm').send({ token: await confirmationToken(pool, member.email), password: member.password })).status, 200);
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

const behindProxy = () => createApp(pool, { ...config, trustProxy: 1 });
const post = (app: ReturnType<typeof createApp>, path: string, address: string, body: object = {}) =>
  request(app).post('/api' + path).set('X-Forwarded-For', address).send(body);
// Rejected before any password check, so they are quick to send. Each names a different
// "account", so only the per-address budget is in play.
let sent = 0;
const malformed = () => ({ email: `not-an-email-${++sent}`, password: 'x' });

test('one address\'s failed sign-ins lock out only that address', async () => {
  const app = behindProxy();
  for (let i = 0; i < 30; i++) assert.equal((await post(app, '/auth/login', '203.0.113.9', malformed())).status, 400);
  const blocked = await post(app, '/auth/login', '203.0.113.9', malformed());
  assert.equal(blocked.status, 429); assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  // Everyone else still signs in, and email confirmation has its own budget.
  assert.equal((await post(app, '/auth/login', '198.51.100.7', member)).status, 200);
  assert.equal((await post(app, '/auth/confirm', '203.0.113.9', { token: 'bad', password: member.password })).status, 400);
});

test('successful sign-ins are not counted against the address', async () => {
  const app = behindProxy();
  for (let i = 0; i < 29; i++) await post(app, '/auth/login', '203.0.113.10', malformed());
  for (let i = 0; i < 3; i++) assert.equal((await post(app, '/auth/login', '203.0.113.10', member)).status, 200);
  assert.equal((await post(app, '/auth/login', '203.0.113.10', malformed())).status, 400);
  assert.equal((await post(app, '/auth/login', '203.0.113.10', malformed())).status, 429);
});

test('wrong passwords for one account are limited without blocking the address\'s other accounts', async () => {
  const app = behindProxy();
  const wrong = { email: ' Limits@Example.invalid ', password: 'WrongPassword!' };
  for (let i = 0; i < 10; i++) assert.equal((await post(app, '/auth/login', '203.0.113.11', wrong)).status, 401);
  assert.equal((await post(app, '/auth/login', '203.0.113.11', member)).status, 429);
  assert.equal((await post(app, '/auth/login', '203.0.113.11', { ...wrong, email: 'someone.else@example.invalid' })).status, 401);
  assert.equal((await post(app, '/auth/login', '198.51.100.8', member)).status, 200);
});

test('retrying after an account is limited never spends the address\'s budget', async () => {
  const app = behindProxy();
  // A too-short password is refused before any password check, so these are quick to send.
  const typo = { email: member.email, password: 'x' };
  for (let i = 0; i < 10; i++) assert.equal((await post(app, '/auth/login', '203.0.113.13', typo)).status, 400);
  for (let i = 0; i < 25; i++) assert.equal((await post(app, '/auth/login', '203.0.113.13', typo)).status, 429);
  // Everyone else behind that address (a front desk, a shared Wi-Fi) keeps the remaining 20.
  for (let i = 0; i < 20; i++) assert.equal((await post(app, '/auth/login', '203.0.113.13', malformed())).status, 400);
  assert.equal((await post(app, '/auth/login', '203.0.113.13', malformed())).status, 429);
});

test('an IPv6 visitor\'s whole /56 (every /64 a home connection holds) shares one budget', async () => {
  const app = behindProxy();
  for (let i = 0; i < 30; i++) assert.equal((await post(app, '/auth/login', `2001:db8:1:2${i.toString(16).padStart(2, '0')}::1`, malformed())).status, 400);
  assert.equal((await post(app, '/auth/login', '2001:db8:1:2ff:ffff::7', malformed())).status, 429);
  assert.equal((await post(app, '/auth/login', '2001:db8:1:300::1', malformed())).status, 400);
});

test('guesses at one account spread over many addresses share one larger budget', async () => {
  const app = behindProxy();
  const guess = { email: member.email, password: 'x' };
  for (let i = 0; i < 100; i++)
    assert.equal((await post(app, '/auth/login', `198.51.100.${i + 100}`, guess)).status, 400);
  assert.equal((await post(app, '/auth/login', '203.0.113.14', member)).status, 429);
  // Other accounts, from those same addresses, are unaffected.
  assert.equal((await post(app, '/auth/login', '198.51.100.100', malformed())).status, 400);
});

test('failed session renewals from one address leave everyone else\'s renewals alone', async () => {
  const app = behindProxy();
  for (let i = 0; i < 120; i++) assert.equal((await post(app, '/auth/refresh', '203.0.113.12')).status, 401);
  assert.equal((await post(app, '/auth/refresh', '203.0.113.12')).status, 429);
  assert.equal((await post(app, '/auth/refresh', '198.51.100.9')).status, 401);
});

test('without TRUST_PROXY a visitor cannot choose their own address', async () => {
  const app = createApp(pool, config);
  for (let i = 0; i < 30; i++) await post(app, '/auth/login', `203.0.113.${i}`, malformed());
  assert.equal((await post(app, '/auth/login', '198.51.100.10', malformed())).status, 429);
});
