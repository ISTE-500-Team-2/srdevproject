import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  AppError,
  bigintId,
  checkProfileFieldTotal,
  dateOfBirthField,
  emailField,
  newPasswordField,
  passwordField,
  positiveId,
  integerId,
  profileFields,
  reservationWindow,
  textField,
} from '../src/domain.js';
import { hashPassword, passwordCost, verifyPassword } from '../src/passwords.js';
import { readConfig } from '../src/config.js';

// Shared email rules preserve meaningful mailbox punctuation and reject malformed input without repairing it.
test('email validation preserves dots and plus tags with the existing case-insensitive identity policy', () => {
  for (const value of [' First.Last+Studio@Example.COM ', " O'Connor@Example.COM ", 'a@xn--bcher-kva.example'])
    assert.equal(emailField(value), value.trim().toLowerCase());
  assert.notEqual(emailField('first.last+studio@gmail.com'), emailField('firstlast@gmail.com'));
});

// Header injection, invisible characters and malformed mailbox/domain syntax must fail before any persistence or delivery.
test('email validation rejects unsafe input, unsupported mailbox formats and storage overflows', () => {
  for (const value of [null, {}, 12, '', 'a..b@example.com', '.a@example.com', 'a.@example.com',
    'a@host_.com', 'a@-host.com', 'a@host..com', 'a@host.123', 'a@localhost', 'a@[127.0.0.1]',
    'Name <a@example.com>', 'a@example.com,b@example.com', 'a@exa mple.com', 'üser@example.com',
    'a@example.com\r\nBcc: victim@example.com', '\na@example.com', 'a@example.com\t',
    'a\u0000@example.com', 'a\u200b@example.com', 'a'.repeat(65)+'@example.com', 'a@'+'b'.repeat(90)+'.example'])
    assert.throws(() => emailField(value), AppError, String(value));
});

test('email login requires a valid address', () => {
  assert.equal(emailField(' Existing@Example.Invalid '),'existing@example.invalid');
  for (const value of [undefined,null,{},'', 'new.member','bad@']) assert.throws(()=>emailField(value),AppError);
});

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

test('PostgreSQL INTEGER identifiers reject overflow without narrowing BIGINT identifiers', () => {
  for (const value of [1, '1', 2147483647, '2147483647']) {
    assert.equal(integerId(value), Number(value));
    assert.equal(positiveId(value), Number(value));
  }
  // Ids and revisions are INTEGER columns: a bigger number is a 400, not a database error.
  for (const value of [2147483648, '2147483648', '3000000000', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER), 0, -1, 1.5, null, {}, '1e5']) {
    assert.throws(() => integerId(value, 'Class'), {name:'Error', status:400, code:'INVALID_INPUT'});
    assert.throws(() => positiveId(value, 'Member'), {name:'Error', status:400, code:'INVALID_INPUT'});
  }
  assert.equal(bigintId('2147483648'), 2147483648);
  assert.throws(() => bigintId(Number.MAX_SAFE_INTEGER + 1), AppError);
});

test('text and profile values refuse control characters but keep tabs and line breaks', () => {
  for (const value of ['Jo\u0000rdan', 'A\u0007b', 'Esc\u001b[0m', 'del\u007f'])
    assert.throws(() => textField(value, 'First name', 50), {status:400, code:'INVALID_INPUT', message:"First name contains a character that can't be saved."});
  assert.equal(textField('Line one\nLine two\tend\r\n', 'Reason', 100), 'Line one\nLine two\tend');
  assert.throws(() => profileFields({ street: 'x\u0000y' }, 'Address'), {status:400, code:'INVALID_INPUT'});
  assert.deepEqual({ ...profileFields({ street: ' 1 Main St ', sms: false }, 'Address') }, { street: '1 Main St', sms: false });
});

test('profile saves cannot pile fields up past the limit across requests', () => {
  const fields = (prefix: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [prefix + i, 'x']));
  const twenty = fields('a', 20);
  // Up to 20 in total is fine, including replacing or removing stored ones.
  checkProfileFieldTotal({}, profileFields(twenty, 'Address'), 'Address');
  checkProfileFieldTotal(twenty, profileFields({ a0: 'y', a1: null }, 'Address'), 'Address');
  checkProfileFieldTotal(fields('a', 19), profileFields({ new: 'y' }, 'Address'), 'Address');
  checkProfileFieldTotal(null, {}, 'Address');
  // A patch that would leave 21 is refused, even though the patch alone is small.
  assert.throws(() => checkProfileFieldTotal(twenty, profileFields({ new: 'y' }, 'Address'), 'Address'),
    {status:400, code:'INVALID_INPUT', message:'Address can contain up to 20 fields.'});
  assert.throws(() => checkProfileFieldTotal(twenty, profileFields(fields('b', 20), 'Address'), 'Address'), AppError);
  // A profile stored over the limit can still be saved as is, or trimmed, but not grown.
  const legacy = fields('a', 25);
  checkProfileFieldTotal(legacy, profileFields({ a0: 'changed' }, 'Address'), 'Address');
  checkProfileFieldTotal(legacy, profileFields({ a0: null, new: 'swap' }, 'Address'), 'Address');
  assert.throws(() => checkProfileFieldTotal(legacy, profileFields({ new: 'y' }, 'Address'), 'Address'), AppError);
});

test('existing passwords are not subject to new-password complexity rules', () => {
  assert.equal(passwordField('existingpassword123'), 'existingpassword123');
  assert.equal(passwordField('123barry987'), '123barry987');

  assert.throws(() => passwordField('Short!'), AppError);
  assert.throws(() => passwordField(null), AppError);
});

test('new passwords require length, uppercase, and a special character', () => {
  assert.equal(newPasswordField('ValidPassword!'), 'ValidPassword!');

  assert.throws(() => newPasswordField('Short!'), AppError);
  assert.throws(() => newPasswordField('lowercasepassword!'), AppError);
  assert.throws(() => newPasswordField('Password123'), AppError);
  assert.throws(() => newPasswordField(null), AppError);
});

test('new passwords stop at 72 UTF-8 bytes, the most bcrypt hashes', async () => {
  const ascii = 'A!' + 'a'.repeat(70);
  assert.equal(newPasswordField(ascii), ascii);
  assert.ok(await hashPassword(newPasswordField(ascii)));
  // 37 accented letters are 74 bytes: under 128 characters, but hashPassword would refuse them.
  const accented = 'A!' + 'é'.repeat(37);
  assert.throws(() => newPasswordField(accented), (error: AppError) =>
    error.code === 'PASSWORD_TOO_LONG' && /8–72 characters; accented letters and emoji count as more than one/.test(error.message));
  await assert.rejects(hashPassword(accented), /72 UTF-8 bytes/);
  assert.throws(() => newPasswordField('A!' + '🔧'.repeat(18)), AppError);
  assert.throws(() => newPasswordField('A!' + 'a'.repeat(71)), AppError);
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
  assert.ok(a.startsWith(`$2b$${String(passwordCost()).padStart(2, '0')}$`));
  await assert.rejects(hashPassword('é'.repeat(37)), /72 UTF-8 bytes/);
  assert.ok(a !== b);
  assert.ok(!a.includes(input));
  assert.ok(await verifyPassword(input, a));
  assert.ok(!(await verifyPassword(randomBytes(24).toString('hex'), a)));
  assert.ok(!(await verifyPassword(input, input)));
});
async function withEnv<T>(values: Record<string, string | undefined>, work: () => T | Promise<T>) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(next))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  try { return await work(); } finally { apply(saved); }
}
test('real accounts keep cost-12 bcrypt; only a non-production cost can be lowered', async () => {
  const password = randomBytes(12).toString('hex');
  const weak = await withEnv({ ARBOR_PASSWORD_COST: '4' }, () => hashPassword(password));
  const strong = await withEnv({ ARBOR_PASSWORD_COST: undefined }, async () => {
    assert.equal(passwordCost(), 12);
    const hash = await hashPassword(password);
    assert.match(hash, /^\$2b\$12\$/);
    assert.ok(await verifyPassword(password, hash));
    // Without the test setting, a low-cost hash is never accepted, even with the right password.
    assert.ok(!(await verifyPassword(password, weak)));
    return hash;
  });
  await withEnv({ ARBOR_PASSWORD_COST: '4' }, async () => {
    assert.match(weak, /^\$2b\$04\$/);
    assert.ok(await verifyPassword(password, weak));
    // Fast test runs still sign in to cost-12 sample accounts.
    assert.ok(await verifyPassword(password, strong));
  });
  for (const value of ['3', '13', '31', 'abc', '4.5', ' 4'])
    await withEnv({ ARBOR_PASSWORD_COST: value }, () =>
      assert.throws(passwordCost, /from 4 to 12/, value));
  await withEnv({ NODE_ENV: 'production', ARBOR_PASSWORD_COST: '4', APP_ORIGIN: 'https://arbor.example' }, async () => {
    assert.throws(passwordCost, /cannot be lowered in production/);
    assert.throws(readConfig, /cannot be lowered in production/);
    await assert.rejects(hashPassword(password), /cannot be lowered in production/);
  });
  await withEnv({ NODE_ENV: 'production', ARBOR_PASSWORD_COST: '12' }, () => assert.equal(passwordCost(), 12));
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
