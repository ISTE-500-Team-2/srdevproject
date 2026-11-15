import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

// Class and training reasons are accepted up to 500 characters; migration 041 widens the
// statusdesc columns they are stored in so a long reason saves instead of failing.
const database = `arbor_reason_length_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const reason = 'Long reason. '.repeat(31).slice(0, 400);
type Session = { id: number; token: string; csrf: string };
let created = false, app: ReturnType<typeof createApp>, admin: Session, member: Session, cert = 0;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32) });
  const login = async (role: string): Promise<Session> => {
    const r = await request(app).post('/api/auth/demo').send({ role });
    assert.equal(r.status, 200, r.text);
    return { id: r.body.data.user.id, token: r.body.data.accessToken, csrf: r.body.data.csrfToken };
  };
  admin = await login('admin');
  member = await login('member');
  cert = (await pool.query("INSERT INTO certifications(certid,name) SELECT COALESCE(MAX(certid),0)+1,'Reason length training' FROM certifications RETURNING certid")).rows[0].certid;
});
after(async () => {
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});
const post = (path: string, body: object) =>
  request(app).post('/api/' + path).set('Authorization', 'Bearer ' + admin.token).set('X-CSRF-Token', admin.csrf).send(body);

test('migration 041 widens both reason columns to 500 characters', async () => {
  const { rows } = await pool.query(`SELECT table_name,character_maximum_length AS length FROM information_schema.columns
    WHERE table_schema='public' AND column_name='statusdesc' AND table_name IN ('reservation','user_certifications') ORDER BY table_name`);
  assert.deepEqual(rows, [{ table_name: 'reservation', length: 500 }, { table_name: 'user_certifications', length: 500 }]);
});

test('a 400-character reason saves when scheduling and cancelling a class', async () => {
  assert.equal(reason.length, 400);
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'", [admin.id]);
  const room = (await pool.query("INSERT INTO room(name,location,capacity,status) VALUES($1,'Reason wing',10,'available') RETURNING roomid",
    ['Reason room ' + randomUUID()])).rows[0].roomid;
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const scheduled = await post('classes', { title: 'Long reason class', certificationId: cert, instructorId: admin.id, roomId: room, capacity: 5,
    startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(), reason });
  assert.equal(scheduled.status, 201, scheduled.text);
  const saved = async () => (await pool.query(`SELECT v.statusdesc,c.revision FROM app_training_class c
    JOIN reservation v ON v.reservationid=c.reservation_id WHERE c.id=$1`, [scheduled.body.data.id])).rows[0];
  assert.equal((await saved()).statusdesc, reason);
  const cancelled = await post(`classes/${scheduled.body.data.id}/cancel`, { expectedRevision: (await saved()).revision, reason: reason.toUpperCase() });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal((await saved()).statusdesc, reason.toUpperCase());
});

test('a 400-character reason saves when recording and revoking training', async () => {
  const path = `training/users/${member.id}/certifications/${cert}`;
  const recorded = await post(path, { trainedAt: new Date(Date.now() - 3_600_000).toISOString(),
    verificationReference: 'In-person check', source: 'equipment', verifiedInPerson: true, reason });
  assert.equal(recorded.status, 201, recorded.text);
  const row = async () => (await pool.query('SELECT statusdesc,status,revision FROM user_certifications WHERE userid=$1 AND certid=$2', [member.id, cert])).rows[0];
  assert.equal((await row()).statusdesc, reason);
  const revoked = await post(`${path}/revoke`, { expectedRevision: (await row()).revision, reason: reason.toUpperCase() });
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual([(await row()).status, (await row()).statusdesc], ['revoked', reason.toUpperCase()]);
});
