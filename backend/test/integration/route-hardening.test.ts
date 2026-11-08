import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { browserSessionLifetimeSeconds } from '../../src/jwt.js';
import { cookieName } from '../../src/middleware/auth.js';
import { apiRoutes } from '../../src/routes.js';
import { ReaderRegistry } from '../../src/readerRegistry.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_routes_' + randomBytes(6).toString('hex') + '_mvc_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
const config: AppConfig = {
  port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York',
  jwtKey: randomBytes(64),
};
const frontend = mkdtempSync(path.join(tmpdir(), 'arbor-frontend-'));
let app: ReturnType<typeof createApp>;
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error('Explicit isolated PostgreSQL configuration required.');
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  mkdirSync(path.join(frontend, 'assets'));
  writeFileSync(path.join(frontend, 'index.html'), '<!doctype html><title>app shell</title>');
  writeFileSync(path.join(frontend, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(path.join(frontend, 'assets', 'app-1234.js'), 'export {};');
  app = createApp(pool, config, frontend);
});
after(async () => {
  rmSync(frontend, { recursive: true, force: true });
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

test('signed out: unknown API paths are 404, real protected ones stay 401', async () => {
  for (const url of ['/api/nope', '/api/admin/nope', '/api/equipment/1/quote/extra']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404, url);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  }
  for (const url of ['/api/equipment', '/api/admin/users', '/api/auth/session']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 401, url);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  }
});

test('every registered API route still answers rather than reporting itself missing', async () => {
  const routes = apiRoutes(pool, config, new ReaderRegistry(pool, config.devices));
  type Layer = { route?: { path: string | string[]; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  const walk = (stack: Layer[]): { path: string; method: string }[] => stack.flatMap((layer) =>
    layer.route
      ? [layer.route.path].flat().flatMap((path) =>
        Object.keys(layer.route!.methods).filter((m) => m !== '_all').map((method) => ({ path, method })))
      : Array.isArray(layer.handle?.stack) ? walk(layer.handle!.stack!) : []);
  const endpoints = walk((routes as unknown as { stack: Layer[] }).stack);
  assert.ok(endpoints.length > 100, `found ${endpoints.length} endpoints`);
  for (const { path: route, method } of endpoints) {
    const url = '/api' + route.replace(/\{[^}]*\}/g, '').replace(/:[A-Za-z]+/g, '1');
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url)
      .set('Origin', 'http://localhost:8080');
    assert.ok(!(res.status === 404 && res.body?.error?.message === 'API endpoint not found.'), `${method.toUpperCase()} ${url}`);
  }
});

test('the CSRF lookup answers signed-out visits with null instead of a 401', async () => {
  const anonymous = await request(app).get('/api/auth/csrf');
  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.body, { data: { csrfToken: null } });
  const stale = await request(app).get('/api/auth/csrf').set('Cookie', `${cookieName}=not-a-real-token`);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.data.csrfToken, null);
  assert.equal((await request(app).post('/api/auth/refresh').set('Cookie', `${cookieName}=not-a-real-token`).send({})).status, 401);

  const signedIn = await request(app).post('/api/auth/demo').send({ role: 'member' });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers['set-cookie'].find((c: string) => c.startsWith(cookieName + '='))!.split(';')[0]!;
  const csrf = await request(app).get('/api/auth/csrf').set('Cookie', cookie);
  assert.equal(csrf.status, 200);
  assert.equal(csrf.body.data.csrfToken, signedIn.body.data.csrfToken);
});

test('without Remember me the server-side sign-in ends within hours, not 30 days', async () => {
  const before = Date.now();
  const signedIn = await request(app).post('/api/auth/demo').send({ role: 'member' });
  assert.equal(signedIn.status, 200);
  const { rows } = await pool.query(
    'SELECT f.expires_at, f.persistent FROM app_session s JOIN app_refresh_family f ON f.id=s.family_id WHERE s.csrf_token=$1',
    [signedIn.body.data.csrfToken],
  );
  assert.equal(rows[0].persistent, false);
  const lifetime = (new Date(rows[0].expires_at).getTime() - before) / 1000;
  assert.ok(Math.abs(lifetime - browserSessionLifetimeSeconds) < 120, `lifetime ${lifetime}s`);
});

test('only page routes get the app shell; files and dot paths are real 404s', async () => {
  for (const url of ['/', '/membership', '/admin/users', '/login?next=%2Fmembership']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.text, /app shell/);
  }
  for (const url of ['/.env', '/.git/config', '/assets/missing-5678.js', '/assets/app-1234.js.map', '/favicon.ico', '/wp-login.php']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404, url);
    assert.doesNotMatch(res.text, /app shell/);
  }
  const robots = await request(app).get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.text, /Disallow: \//);
  assert.equal((await request(app).get('/assets/app-1234.js')).status, 200);
});
