import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  AppError,
  dateOfBirthField,
  emailField,
  passwordField,
  positiveId,
  reservationWindow,
} from '../src/domain.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import { readConfig } from '../src/config.js';

test('reservation times are explicit, valid, future intervals of at most 24 hours', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const result = reservationWindow(
    '2030-01-02T10:00:00-05:00',
    '2030-01-02T12:00:00-05:00',
    now,
  );
  assert.equal(result.start.toISOString(), '2030-01-02T15:00:00.000Z');
  for (const [start, end] of [
    ['2030-01-02T10:00', '2030-01-02T11:00'],
    ['2030-02-30T10:00:00Z', '2030-03-03T10:00:00Z'],
    ['2030-01-02T24:00:00Z', '2030-01-03T01:00:00Z'],
    ['2030-01-02T10:00:00Z', '2030-01-02T10:00:00Z'],
    ['2030-01-02T10:00:00Z', '2030-01-03T11:00:00Z'],
    ['2029-01-02T10:00:00Z', '2029-01-02T11:00:00Z'],
  ])
    assert.throws(() => reservationWindow(start, end, now), AppError);
});
test('identifiers and emails are validated without coercing arbitrary values', () => {
  for (const value of [
    0,
    -1,
    1.5,
    true,
    null,
    {},
    '1; DROP TABLE equipment',
    '1e5',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => positiveId(value), AppError);
  assert.equal(positiveId('12'), 12);
  assert.equal(emailField('  Member@Example.org  '), 'member@example.org');
  assert.throws(() => emailField('not-an-email'), AppError);
});

test('registration passwords require length, uppercase, and a special character', () => {
  assert.equal(passwordField('ValidPassword!'), 'ValidPassword!');

  assert.throws(() => passwordField('Short!'), AppError);
  assert.throws(() => passwordField('lowercasepassword!'), AppError);
  assert.throws(() => passwordField('Password123'), AppError);
  assert.throws(() => passwordField(null), AppError);
});

test('dates of birth require a valid YYYY-MM-DD date that is not in the future', () => {
  assert.equal(dateOfBirthField('2000-01-01'), '2000-01-01');

  assert.throws(() => dateOfBirthField('01/01/2000'), AppError);
  assert.throws(() => dateOfBirthField('2000-02-30'), AppError);
  assert.throws(() => dateOfBirthField('2999-01-01'), AppError);
  assert.throws(() => dateOfBirthField(undefined), AppError);
});

test('password hashes are salted and legacy plaintext is not accepted', async () => {
  const input = randomBytes(24).toString('hex');
  const a = await hashPassword(input),
    b = await hashPassword(input);
  assert.ok(a !== b);
  assert.ok(!a.includes(input));
  assert.ok(await verifyPassword(input, a));
  assert.ok(!(await verifyPassword(randomBytes(24).toString('hex'), a)));
  assert.ok(!(await verifyPassword(input, input)));
});
test('development shortcut cannot be enabled in production', () => {
  const nodeEnv = process.env.NODE_ENV,
    demo = process.env.ENABLE_DEMO_LOGIN;
  try {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEMO_LOGIN = 'true';
    assert.throws(readConfig, /forbidden/);
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (demo === undefined) delete process.env.ENABLE_DEMO_LOGIN;
    else process.env.ENABLE_DEMO_LOGIN = demo;
  }
});
