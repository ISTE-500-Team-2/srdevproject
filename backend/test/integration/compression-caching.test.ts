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
import { cookieName } from '../../src/middleware/auth.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_compress_' + randomBytes(6).toString('hex') + '_mvc_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
const config: AppConfig = {
  port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York',
  jwtKey: randomBytes(64),
};
const frontend = mkdtempSync(path.join(tmpdir(), 'arbor-frontend-'));
// Repetitive but realistic sizes: well above the 1 KB compression threshold.
const bundle = 'export const rows = [' + Array.from({ length: 2000 }, (_, i) => `{id:${i},name:"row ${i}"}`).join(',') + '];\n';
const shell = '<!doctype html><title>app shell</title>' + '<meta name="x" content="padding">'.repeat(100);
const immutable = 'public, max-age=31536000, immutable';
let app: ReturnType<typeof createApp>;
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error('Explicit isolated PostgreSQL configuration required.');
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  mkdirSync(path.join(frontend, 'assets'));
  mkdirSync(path.join(frontend, '.vite'));
  writeFileSync(path.join(frontend, 'index.html'), shell);
  writeFileSync(path.join(frontend, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(path.join(frontend, 'assets', 'index-AbCd1234.js'), bundle);
  writeFileSync(path.join(frontend, 'assets', 'index-EfGh5678.css'), 'body{margin:0}');
  // Copied verbatim from frontend/public/assets: same name every release.
  writeFileSync(path.join(frontend, 'assets', 'collaboratory-logo.webp'), randomBytes(64));
  writeFileSync(path.join(frontend, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true, css: ['assets/index-EfGh5678.css'] },
  }));
  app = createApp(pool, config, frontend);
});
after(async () => {
  rmSync(frontend, { recursive: true, force: true });
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

// superagent decodes gzip/br itself; collect the decoded bytes for any type.
const raw = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

test('a large hashed bundle is compressed for clients that accept it and cached forever', async () => {
  for (const [accept, encoding] of [['gzip', 'gzip'], ['gzip, deflate, br', 'br']] as const) {
    const res = await request(app).get('/assets/index-AbCd1234.js').set('Accept-Encoding', accept).buffer(true).parse(raw);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], encoding, accept);
    assert.match(res.headers.vary, /Accept-Encoding/);
    assert.equal(res.headers['cache-control'], immutable);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal((res.body as Buffer).toString(), bundle);
  }
  const plain = await request(app).get('/assets/index-AbCd1234.js').set('Accept-Encoding', 'identity');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(Number(plain.headers['content-length']), Buffer.byteLength(bundle));
  assert.equal((await request(app).get('/assets/index-EfGh5678.css')).headers['cache-control'], immutable);
});

test('unhashed files, including public/assets copies, always revalidate', async () => {
  for (const url of ['/assets/collaboratory-logo.webp', '/robots.txt']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers['cache-control'], 'no-cache', url);
  }
});

test('the SPA fallback shell revalidates and is compressed', async () => {
  const res = await request(app).get('/admin/dashboard').set('Accept-Encoding', 'gzip');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.text, shell);
  assert.equal(res.headers['referrer-policy'], 'same-origin');
});

test('missing assets, dot paths and the manifest itself stay plain 404s', async () => {
  // The release edge retries a 404 /assets/... against the previous release.
  for (const url of ['/assets/index-gone0000.js', '/.vite/manifest.json', '/.env']) {
    const res = await request(app).get(url).set('Accept-Encoding', 'gzip, br');
    assert.equal(res.status, 404, url);
    assert.equal(res.text, 'Not found', url);
  }
});

test('large authenticated API JSON is compressed and still never stored', async () => {
  const signedIn = await request(app).post('/api/auth/demo').send({ role: 'admin' });
  assert.equal(signedIn.status, 200);
  const bearer = 'Bearer ' + signedIn.body.data.accessToken;
  const plain = await request(app).get('/api/admin/compliance').set('Authorization', bearer).set('Accept-Encoding', 'identity');
  assert.equal(plain.status, 200);
  assert.ok(Number(plain.headers['content-length']) > 1024, `compliance is ${plain.headers['content-length']} bytes`);
  for (const [accept, encoding] of [['gzip', 'gzip'], ['br', 'br']] as const) {
    const res = await request(app).get('/api/admin/compliance').set('Authorization', bearer).set('Accept-Encoding', accept);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], encoding);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, plain.body);
  }
});

test('auth, reader and webhook responses are never compressed, whatever the client accepts', async () => {
  const signedIn = await request(app).post('/api/auth/demo').set('Accept-Encoding', 'gzip, br').send({ role: 'admin' });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers['set-cookie'].find((c: string) => c.startsWith(cookieName + '='))!.split(';')[0]!;
  const bearer = 'Bearer ' + signedIn.body.data.accessToken;
  const responses = [
    signedIn,
    await request(app).get('/api/auth/csrf').set('Cookie', cookie).set('Accept-Encoding', 'gzip, br'),
    await request(app).get('/api/auth/session').set('Authorization', bearer).set('Accept-Encoding', 'gzip, br'),
    await request(app).get('/API/Auth/session').set('Authorization', bearer).set('Accept-Encoding', 'gzip, br'),
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).set('Accept-Encoding', 'gzip, br').send({}),
    await request(app).post('/api/devices/decision').set('Content-Type', 'application/json').set('Accept-Encoding', 'gzip, br').send('{}'),
    await request(app).post('/api/webhooks/brevo').set('Accept-Encoding', 'gzip, br').send({}),
  ];
  for (const res of responses) {
    const url = `${res.req.method} ${res.req.path}`;
    assert.equal(res.headers['content-encoding'], undefined, url);
    // compression adds Vary only once a response passes the filter, so its
    // absence proves exclusion even for bodies under the size threshold.
    assert.doesNotMatch(String(res.headers.vary ?? ''), /Accept-Encoding/i, url);
    assert.equal(res.headers['cache-control'], 'no-store', url);
  }
  // The same small body elsewhere in the API does pass the filter.
  const other = await request(app).get('/api/admin/policies').set('Authorization', bearer).set('Accept-Encoding', 'gzip, br');
  assert.equal(other.status, 200);
  assert.match(other.headers.vary, /Accept-Encoding/);
});
