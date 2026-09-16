import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { migrate, repositoryRoot } from '../../src/scripts/migrate.js';

const database = 'arbor_sample_' + randomBytes(6).toString('hex') + '_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
let created = false;
const app = createApp(pool, {
  jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
  demoLogin: false, allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York',
});
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL configuration required');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await pool.query(await readFile(path.join(repositoryRoot, 'ddl/collaboratory-db-create.sql'), 'utf8'));
  await pool.query(await readFile(path.join(repositoryRoot, 'ddl/collaboratory-insert.sql'), 'utf8'));
  await migrate(pool);
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

test('real SQL sample users authenticate with plaintext input against bcrypt storage', async () => {
  const cases = [
    ['johndoe@example.com', 'JohnDemo123!', 200],
    ['janesmith@example.com', 'janesmith', 200],
    ['JDeen1999@gmail.com', '1!J$$D!@', 200],
    ['RoseyM@gmail.com', 'MaryLamb428', 200],
    ['MarkBar13@yahoo.com', 'mYp@ssw0rd111', 403],
    ['KatKat@yahoo.com', '123barry987', 200],
  ] as const;
  const hashes = await pool.query('SELECT password FROM "user"');
  assert.equal(hashes.rowCount, 6);
  for (const row of hashes.rows) assert.match(row.password, /^\$2[aby]\$12\$/);
  for (const [email, password, expected] of cases) {
    const result = await request(app).post('/api/auth/login').send({ email, password });
    assert.equal(result.status, expected, `${email}: ${JSON.stringify(result.body.error)}`);
    if (expected === 200) {
      assert.ok(result.body.data.accessToken);
      assert.equal(result.body.data.user.email.toLowerCase(), email.toLowerCase());
    }
  }
  const bad = await request(app).post('/api/auth/login').send({email: 'johndoe@example.com', password: 'WrongPassword123!'});
  assert.equal(bad.status, 401);
});

test('repair upgrades only exact legacy samples and is idempotent', async () => {
  await pool.query('UPDATE "user" SET password=$1 WHERE userid=1', ['johndoe']);
  await pool.query('UPDATE "user" SET password=$1 WHERE userid=3', ['different-user-owned-value']);
  const before = (await pool.query('SELECT * FROM "user" ORDER BY userid')).rows;
  const sql = await readFile(path.join(repositoryRoot, 'database/fixes/repair-sample-passwords.sql'), 'utf8');
  await pool.query(sql);
  const repaired = (await pool.query('SELECT * FROM "user" ORDER BY userid')).rows;
  assert.match(repaired[0].password, /^\$2[aby]\$12\$/);
  for (let i=0;i<before.length;i++) {
    const {password: previous, ...oldFields} = before[i];
    const {password: next, ...newFields} = repaired[i];
    assert.deepEqual(newFields, oldFields);
    if (i!==0) assert.equal(next, previous);
  }
  await pool.query(sql);
  assert.deepEqual((await pool.query('SELECT * FROM "user" ORDER BY userid')).rows, repaired);
  const result = await request(app).post('/api/auth/login').send({email:'johndoe@example.com',password:'JohnDemo123!'});
  assert.equal(result.status,200);
});
