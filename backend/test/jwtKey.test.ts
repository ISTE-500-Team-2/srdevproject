import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJwtKey } from '../src/jwtKey.js';

test('development generates a private key once and reuses it across startups', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arbor-jwt-key-test-'));
  try {
    const keyFile = path.join(directory, 'private', 'key');
    const env = { NODE_ENV: 'development', JWT_DEV_KEY_FILE: keyFile };
    const first = readJwtKey(env);
    assert.equal(first.byteLength, 32);
    assert.ok(Buffer.from(first).equals(Buffer.from(readJwtKey(env))), 'key must survive a restart');
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(keyFile)).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('production requires a provisioned key and never generates or replaces one', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arbor-jwt-key-test-'));
  try {
    const keyFile = path.join(directory, 'key');
    assert.throws(() => readJwtKey({ NODE_ENV: 'production', JWT_DEV_KEY_FILE: keyFile }), /JWT_SECRET_FILE/);
    assert.throws(() => readJwtKey({ NODE_ENV: 'production', JWT_SECRET_FILE: keyFile }), /ENOENT/);
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const original = readFileSync(keyFile);
    assert.ok(original.equals(Buffer.from(readJwtKey({ NODE_ENV: 'production', JWT_SECRET_FILE: keyFile }))));
    assert.ok(original.equals(readFileSync(keyFile)), 'provisioned file must not be changed');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('an undersized persisted key fails closed instead of silently rotating', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arbor-jwt-key-test-'));
  try {
    const keyFile = path.join(directory, 'key');
    writeFileSync(keyFile, randomBytes(16), { mode: 0o600 });
    for (const env of [
      { NODE_ENV: 'production', JWT_SECRET_FILE: keyFile },
      { NODE_ENV: 'development', JWT_DEV_KEY_FILE: keyFile },
    ]) assert.throws(() => readJwtKey(env), /at least 32/);
    assert.equal(statSync(keyFile).size, 16);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
