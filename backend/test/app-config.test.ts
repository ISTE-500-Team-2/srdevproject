import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';

/** readConfig with only these settings changed, restoring the environment afterwards. */
function configWith(settings: Record<string, string | undefined>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arbor-config-'));
  const keyFile = path.join(directory, 'jwt.key');
  writeFileSync(keyFile, randomBytes(32));
  const names = ['APP_TIME_ZONE', 'TRUST_PROXY', 'JWT_SECRET_FILE', 'NODE_ENV'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.NODE_ENV;
    process.env.JWT_SECRET_FILE = keyFile;
    for (const name of ['APP_TIME_ZONE', 'TRUST_PROXY']) delete process.env[name];
    for (const [name, value] of Object.entries(settings)) if (value !== undefined) process.env[name] = value;
    return readConfig();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a blank time zone uses the default, and a mistyped one stops startup', () => {
  assert.equal(configWith({}).timeZone, 'America/New_York');
  assert.equal(configWith({ APP_TIME_ZONE: '' }).timeZone, 'America/New_York');
  assert.equal(configWith({ APP_TIME_ZONE: '  ' }).timeZone, 'America/New_York');
  assert.equal(configWith({ APP_TIME_ZONE: ' America/Chicago ' }).timeZone, 'America/Chicago');
  for (const zone of ['Eastern', 'America/New York', 'Not/AZone'])
    assert.throws(() => configWith({ APP_TIME_ZONE: zone }), /APP_TIME_ZONE/, zone);
});

test('TRUST_PROXY names a hop count or proxy addresses, and never every hop', () => {
  assert.equal(configWith({}).trustProxy, undefined);
  assert.equal(configWith({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.deepEqual(configWith({ TRUST_PROXY: 'loopback, 172.18.0.0/16, ::1' }).trustProxy, ['loopback', '172.18.0.0/16', '::1']);
  for (const value of ['true', '0', '11', 'proxy.example', '1.5'])
    assert.throws(() => configWith({ TRUST_PROXY: value }), /TRUST_PROXY/, value);
});
