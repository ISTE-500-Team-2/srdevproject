import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import request from 'supertest';
import { addressBudget, authRateLimit, maxBudgetEntries, refreshToken } from '../src/middleware/auth.js';
import { AppError } from '../src/domain.js';
import { createEdge } from '../../deploy/rles-edge.mjs';

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

test('an IPv6 /56 counts as one address; IPv4 (plain or mapped) counts alone', () => {
  assert.equal(addressBudget('2001:db8:0:1::5'), '2001:db8:0:0::/56');
  assert.equal(addressBudget('2001:0DB8:0000:01ff:aaaa:bbbb:cccc:dddd'), '2001:db8:0:100::/56');
  assert.equal(addressBudget('2001:db8:0:1ab::1'), '2001:db8:0:100::/56');
  assert.equal(addressBudget('2001:db8::'), '2001:db8:0:0::/56');
  for (const alone of ['203.0.113.9', '::ffff:203.0.113.9', '::ffff:cb00:7109', '::FFFF:203.0.113.9'])
    assert.equal(addressBudget(alone), '203.0.113.9', alone);
  for (const edge of ['172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '11.0.0.1', '8.8.8.8'])
    assert.equal(addressBudget(edge), edge, edge);
});

// A proxy, a Docker bridge or a campus network seen from inside can stand for everyone.
test('a missing, loopback, private, link-local or unique-local address is unknown', () => {
  for (const unknown of [undefined, '', 'unknown', 'spoofed', '127.0.0.1', '127.8.9.10', '::1', '::', '0.0.0.0',
    '10.0.0.5', '172.16.1.254', '172.31.255.255', '192.168.1.1', '169.254.10.1', '100.64.0.1',
    '::ffff:127.0.0.1', '::ffff:172.18.0.1', '::ffff:ac12:1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1'])
    assert.equal(addressBudget(unknown), undefined, String(unknown));
});

const login = () => [
  authRateLimit({ limit: 10, failuresOnly: true, key: (req: Request) => String(req.body.email ?? '') }),
  authRateLimit({ failuresOnly: true }),
  authRateLimit({ limit: 100, failuresOnly: true, perAddress: false, key: (req: Request) => String(req.body.email ?? '') }),
];

test('failures from one unknown address across many accounts never lock out another account', async () => {
  for (const address of ['10.0.0.5', '172.16.1.254', undefined]) {
    const server = app(...login());
    const send = (body: object) => address ? from(server, address, body) : request(server).post('/attempt').send(body);
    for (let i = 0; i < 200; i++) assert.equal((await send({ email: `guess${i}@example.com` })).status, 401);
    // Not even a request naming no account is refused: there is no budget for "everyone".
    for (let i = 0; i < 40; i++) assert.equal((await send({})).status, 401);
    assert.equal((await send({ email: 'member@example.com' })).status, 401);
    assert.equal((await send({ email: 'member@example.com', ok: true })).status, 200);
  }
});

test('one account is still locked after 10 failures, wherever unknown addresses send them', async () => {
  const server = app(...login());
  const wrong = { email: 'member@example.com' };
  for (const address of ['10.0.0.1', '10.0.0.2', '192.168.0.3', '172.16.1.254', '127.0.0.1'])
    for (let i = 0; i < 2; i++) assert.equal((await from(server, address, wrong)).status, 401);
  const blocked = await from(server, '10.9.9.9', { ...wrong, ok: true });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  // From a public address that account has 10 of its own, short of the 100 across every address.
  assert.equal((await from(server, '203.0.113.9', { ...wrong, ok: true })).status, 200);
  assert.equal((await from(server, '10.0.0.1', { email: 'other@example.com', ok: true })).status, 200);
});

test('one public address is still locked after 30 failures across accounts; nobody else is', async () => {
  const server = app(...login());
  for (let i = 0; i < 30; i++) assert.equal((await from(server, '203.0.113.9', { email: `guess${i}@example.com` })).status, 401);
  assert.equal((await from(server, '203.0.113.9', { email: 'member@example.com', ok: true })).status, 429);
  assert.equal((await from(server, '::ffff:203.0.113.9', { email: 'member@example.com', ok: true })).status, 429);
  assert.equal((await from(server, '198.51.100.7', { email: 'member@example.com', ok: true })).status, 200);
  assert.equal((await from(server, '10.0.0.5', { email: 'member@example.com', ok: true })).status, 200);
});

const direct = (limiter: ReturnType<typeof authRateLimit>) => {
  const res = { set() { return this; }, once() { return this; } } as unknown as Response;
  return (ip: string, body: object = {}) => {
    let passed = false;
    try { limiter({ ip, body } as Request, res, () => { passed = true; }); } catch (error) { if ((error as AppError).status !== 429) throw error; }
    return passed;
  };
};

test('a full table forgets its least-used entry instead of refusing every newcomer', () => {
  const byAddress = direct(authRateLimit({ limit: 5 }));
  for (let i = 0; i < maxBudgetEntries; i++) assert.ok(byAddress(`11.0.${i >> 8}.${i & 255}`));
  assert.ok(byAddress('198.51.100.7'));
  // The same holds for per-account budgets, filled with made-up accounts from unknown addresses.
  const byAccount = direct(authRateLimit({ limit: 5, perAddress: false, key: (req: Request) => req.body.email }));
  for (let i = 0; i < maxBudgetEntries * 2; i++) assert.ok(byAccount('10.0.0.5', { email: `fake${i}@example.com` }));
  assert.ok(byAccount('10.0.0.5', { email: 'member@example.com' }));
});

// Flooding the table with new keys must not wipe the count someone is trying to get past.
test('filling the table with new keys never frees the oldest, used-up budget', () => {
  const attempt = direct(authRateLimit({ limit: 5 }));
  for (let i = 0; i < 5; i++) assert.ok(attempt('203.0.113.9'));
  assert.equal(attempt('203.0.113.9'), false);
  for (let i = 0; i < maxBudgetEntries * 2; i++) assert.ok(attempt(`11.${i >> 16}.${(i >> 8) & 255}.${i & 255}`));
  assert.equal(attempt('203.0.113.9'), false);
});

test('behind one trusted hop, the RLES edge\'s single X-Forwarded-For entry becomes req.ip (opt-in) or is unknown (default)', async () => {
  const seen: (string | undefined)[] = [];
  const server = express();
  server.set('trust proxy', 1);
  server.get('/ip', (req, res) => { seen.push(req.ip); res.end(); });
  const listen = (s: { listen: (port: number, host: string, cb: () => void) => void; address: () => unknown }) =>
    new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
  const application = server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => application.once('listening', resolve));
  const edge = createEdge({ digest: createHash('sha256').update('fixture').digest('hex'), allowedPeers: ['127.0.0.1'],
    stateFile: 'unused', applicationPort: (application.address() as AddressInfo).port, trustForwardedFor: true });
  const base = `http://127.0.0.1:${await listen(edge)}`;
  // Until GATEWAY_TRUST_FORWARDED_FOR is checked and set, the edge names its peer: never a shared budget.
  const cautious = createEdge({ digest: createHash('sha256').update('fixture').digest('hex'), allowedPeers: ['127.0.0.1'],
    stateFile: 'unused', applicationPort: (application.address() as AddressInfo).port });
  const cautiousBase = `http://127.0.0.1:${await listen(cautious)}`;
  try {
    for (const [forwarded, expected] of [['203.0.113.9', '203.0.113.9'], ['198.51.100.7, 10.0.0.1, 203.0.113.9', '203.0.113.9'],
      ['2001:db8::7', '2001:db8::7']]) {
      await fetch(base + '/ip', { headers: { 'X-Forwarded-For': forwarded! } });
      assert.equal(seen.at(-1), expected);
      assert.ok(addressBudget(seen.at(-1)));
    }
    // With no usable header, the app sees the edge itself: an address it treats as unknown.
    for (const headers of [{}, { 'X-Forwarded-For': '203.0.113.9, spoofed' }] as Record<string, string>[]) {
      await fetch(base + '/ip', { headers });
      assert.match(seen.at(-1)!, /127\.0\.0\.1$/);
      assert.equal(addressBudget(seen.at(-1)), undefined);
    }
    await fetch(cautiousBase + '/ip', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.match(seen.at(-1)!, /127\.0\.0\.1$/);
    assert.equal(addressBudget(seen.at(-1)), undefined);
    // Directly, too: one trusted hop takes the last entry and ignores the rest.
    await request(server).get('/ip').set('X-Forwarded-For', '192.0.2.1, 203.0.113.10');
    assert.equal(seen.at(-1), '203.0.113.10');
  } finally {
    for (const s of [edge, cautious, application]) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
  }
});

test('a second refresh cookie (planted from a sibling site) is never used to pick the session', () => {
  const cookie = (value: string) => refreshToken({ headers: { cookie: value } } as Request);
  assert.equal(cookie('theme=dark; arbor_refresh=own-token'), 'own-token');
  assert.equal(cookie('arbor_refresh=planted; arbor_refresh=own-token'), '');
  assert.equal(cookie('theme=dark'), '');
});
