// Run only against CI's isolated Compose demo; keep JWT/CSRF values in memory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const origin = 'http://localhost:8081';
const url = 'http://127.0.0.1:8081/api';
async function call(path, { method = 'GET', cookie, csrf, body } = {}) {
  return fetch(url + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
}

const login = await call('/auth/demo', { method: 'POST', body: { role: 'member' } });
assert.equal(login.status, 200, 'container login failed');
const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
assert.ok(cookie?.startsWith('arbor_session='), 'auth cookie missing');
const token = cookie.slice('arbor_session='.length);
assert.equal(token.split('.').length, 3, 'cookie must contain a JWT');
const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
assert.equal(header.alg, 'HS256');
assert.equal(header.typ, 'JWT');
const { data } = await login.json();
assert.equal((await call('/auth/session', { cookie })).status, 200);

// Recreate, not merely restart: the private key must survive on the volume.
execFileSync('docker', [
  'compose', '-p', 'arbor-jwt-ci', '-f', 'compose.mvc.yml',
  'up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'app',
], { stdio: 'pipe', timeout: 120000 });
assert.equal((await call('/auth/session', { cookie })).status, 200, 'JWT must survive container recreation');
assert.equal((await call('/auth/logout', { method: 'POST', cookie, body: {} })).status, 403);
assert.equal((await call('/auth/logout', { method: 'POST', cookie, csrf: data.csrfToken, body: {} })).status, 204);
assert.equal((await call('/auth/session', { cookie })).status, 401, 'logout must revoke the JWT');
console.log('Docker JWT smoke test passed: login, container recreation, CSRF and logout revocation.');
