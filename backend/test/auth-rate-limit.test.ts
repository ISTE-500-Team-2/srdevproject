import assert from 'node:assert/strict';
import { test } from 'node:test';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import request from 'supertest';
import { addressBudget, authRateLimit, refreshToken } from '../src/middleware/auth.js';
import { AppError } from '../src/domain.js';

// A tiny app behind one trusted proxy hop, like production: the limiter must count visitors, not the proxy.
function app(...limiters: ReturnType<typeof authRateLimit>[]) {
  const server = express();
  server.set('trust proxy', 1);
  server.use(express.json());
  server.post('/attempt', ...limiters, (req, res) => {
    if (req.body.ok) res.json({ data: 'ok' });
    else throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  });
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code } });
  };
  server.use(onError);
  return server;
}
const from = (server: express.Express, address: string, body: object = {}) =>
  request(server).post('/attempt').set('X-Forwarded-For', address).send(body);

test('one visitor using up their attempts does not lock out anyone else', async () => {
  const server = app(authRateLimit({ limit: 3 }));
  for (let i = 0; i < 3; i++) assert.equal((await from(server, '203.0.113.9')).status, 401);
  const blocked = await from(server, '203.0.113.9');
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
  assert.equal((await from(server, '198.51.100.7', { ok: true })).status, 200);
});

test('with failuresOnly, successful requests never use up the allowance', async () => {
  const server = app(authRateLimit({ limit: 3, failuresOnly: true }));
  for (let i = 0; i < 20; i++) assert.equal((await from(server, '203.0.113.9', { ok: true })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await from(server, '203.0.113.9')).status, 401);
  assert.equal((await from(server, '203.0.113.9', { ok: true })).status, 429);
});

test('a key narrows the budget, so one account\'s failures leave the address\'s other accounts alone', async () => {
  const server = app(authRateLimit({ limit: 2, failuresOnly: true, key: (req: Request) => String(req.body.email) }));
  for (let i = 0; i < 2; i++) assert.equal((await from(server, '203.0.113.9', { email: 'a@example.com' })).status, 401);
  assert.equal((await from(server, '203.0.113.9', { email: 'a@example.com' })).status, 429);
  assert.equal((await from(server, '203.0.113.9', { email: 'b@example.com' })).status, 401);
  assert.equal((await from(server, '198.51.100.7', { email: 'a@example.com' })).status, 401);
});

test('a request one budget refuses never spends the others on the route', async () => {
  // The address budget runs first here, so it has already counted each refused retry.
  const perAddress = authRateLimit({ limit: 5, failuresOnly: true });
  const perAccount = authRateLimit({ limit: 2, failuresOnly: true, key: (req: Request) => String(req.body.email) });
  const server = app(perAddress, perAccount);
  for (let i = 0; i < 2; i++) assert.equal((await from(server, '203.0.113.9', { email: 'a' })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await from(server, '203.0.113.9', { email: 'a' })).status, 429);
  for (let i = 0; i < 3; i++) assert.equal((await from(server, '203.0.113.9', { email: `b${i}` })).status, 401);
  assert.equal((await from(server, '203.0.113.9', { email: 'c' })).status, 429);
});

test('with perAddress: false, a key shares one budget across every address', async () => {
  const server = app(authRateLimit({ limit: 2, failuresOnly: true, perAddress: false, key: (req: Request) => String(req.body.email) }));
  assert.equal((await from(server, '203.0.113.9', { email: 'a' })).status, 401);
  assert.equal((await from(server, '198.51.100.7', { email: 'a' })).status, 401);
  assert.equal((await from(server, '192.0.2.1', { email: 'a' })).status, 429);
  assert.equal((await from(server, '192.0.2.1', { email: 'b' })).status, 401);
});

test('an IPv6 /56 counts as one address; IPv4, mapped and loopback addresses count alone', () => {
  assert.equal(addressBudget('2001:db8:0:1::5'), '2001:db8:0:0::/56');
  assert.equal(addressBudget('2001:0DB8:0000:01ff:aaaa:bbbb:cccc:dddd'), '2001:db8:0:100::/56');
  assert.equal(addressBudget('2001:db8:0:1ab::1'), '2001:db8:0:100::/56');
  assert.equal(addressBudget('2001:db8::'), '2001:db8:0:0::/56');
  assert.equal(addressBudget('fe80::1%eth0'), 'fe80:0:0:0::/56');
  for (const alone of ['203.0.113.9', '::ffff:203.0.113.9', '::ffff:cb00:7109', '::1', 'unknown'])
    assert.equal(addressBudget(alone), alone);
  assert.equal(addressBudget(undefined), 'unknown');
});

test('a full table forgets its oldest entry instead of refusing every newcomer', () => {
  const limiter = authRateLimit({ limit: 5 });
  const res = { set() { return this; }, once() { return this; } } as unknown as Response;
  const attempt = (ip: string) => { let passed = false; limiter({ ip } as Request, res, () => { passed = true; }); return passed; };
  for (let i = 0; i < 2048; i++) assert.ok(attempt(`10.0.${i >> 8}.${i & 255}`));
  assert.ok(attempt('198.51.100.7'));
});

test('a second refresh cookie (planted from a sibling site) is never used to pick the session', () => {
  const cookie = (value: string) => refreshToken({ headers: { cookie: value } } as Request);
  assert.equal(cookie('theme=dark; arbor_refresh=own-token'), 'own-token');
  assert.equal(cookie('arbor_refresh=planted; arbor_refresh=own-token'), '');
  assert.equal(cookie('theme=dark'), '');
});
