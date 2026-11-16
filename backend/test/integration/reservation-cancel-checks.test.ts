import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

// Staff cancel must not act on a booking that changed after it was shown, and a member
// re-cancelling their own finished booking gets a specific answer instead of "not found".
const database = 'arbor_cancel_checks_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const hour = 3_600_000;
type Session = { id: number; token: string; csrf: string };
let created = false, app: ReturnType<typeof createApp>, member: Session, admin: Session, machine = 0, day = 0;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32) });
  const login = async (role: string): Promise<Session> => {
    const r = await request(app).post('/api/auth/demo').send({ role });
    assert.equal(r.status, 200, r.text);
    return { id: r.body.data.user.id, token: r.body.data.accessToken, csrf: r.body.data.csrfToken };
  };
  member = await login('member');
  admin = await login('admin');
  machine = (await pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
    VALUES($1,'available','10',false,'Cancel lab') RETURNING equipmentid`, ['Cancel machine ' + randomUUID()])).rows[0].equipmentid;
});
after(async () => {
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

/** A booking `daysAhead` from now (negative for the past). */
async function booking(userId: number, daysAhead = 30, status = 'confirmed') {
  // Spaced so bookings on the one machine never overlap.
  const start = new Date(Date.now() + daysAhead * 24 * hour + day++ * 61 * 60_000);
  return (await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Cancel lab',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC',$5)
    RETURNING reservationid AS id,revision`, [userId, machine, start, new Date(start.getTime() + hour), status])).rows[0] as { id: number; revision: number };
}
const post = (who: Session, path: string, body: object = {}) =>
  request(app).post('/api/' + path).set('Authorization', 'Bearer ' + who.token).set('X-CSRF-Token', who.csrf).send(body);
const status = async (id: number) => (await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [id])).rows[0].status;

test('staff cancel refuses a revision that a colleague has since changed, and cancels the current one', async () => {
  const shown = await booking(member.id);
  // A colleague moves the booking after the cancel prompt was drawn from the old details.
  await pool.query(`UPDATE reservation SET starttime=starttime+interval '2 hours',endtime=endtime+interval '2 hours',revision=revision+1
    WHERE reservationid=$1`, [shown.id]);
  const stale = await post(admin, `admin/reservations/${shown.id}/cancel`, { expectedRevision: shown.revision });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'STALE_RECORD'], stale.text);
  assert.equal(await status(shown.id), 'confirmed');

  const current = await post(admin, `admin/reservations/${shown.id}/cancel`, { expectedRevision: shown.revision + 1 });
  assert.equal(current.status, 200, current.text);
  assert.equal(current.body.data.status, 'cancelled');
  assert.equal(await status(shown.id), 'cancelled');

  // Clients that send no revision (the equipment page's staff cancel) keep working.
  const unchecked = await booking(member.id);
  const plain = await post(admin, `admin/reservations/${unchecked.id}/cancel`);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(await status(unchecked.id), 'cancelled');
});

test('a member cancelling a booking that was already cancelled or has ended is told so; others stay not found', async () => {
  const already = 'This booking was already cancelled or has ended.';
  const mine = await booking(member.id);
  assert.equal((await post(member, `reservations/${mine.id}/cancel`)).status, 200);
  const again = await post(member, `reservations/${mine.id}/cancel`);
  assert.deepEqual([again.status, again.body.error.code, again.body.error.message], [409, 'INVALID_STATUS', already]);

  const ended = await booking(member.id, -3);
  const past = await post(member, `reservations/${ended.id}/cancel`);
  assert.deepEqual([past.status, past.body.error.code, past.body.error.message], [409, 'INVALID_STATUS', already]);
  assert.equal(await status(ended.id), 'confirmed');

  // Someone else's booking, even a cancelled one, reveals nothing.
  for (const theirs of [await booking(admin.id), await booking(admin.id, 30, 'cancelled')]) {
    const other = await post(member, `reservations/${theirs.id}/cancel`);
    assert.deepEqual([other.status, other.body.error.code, other.body.error.message],
      [404, 'NOT_FOUND', 'No cancellable reservation was found for this account.']);
  }

  // Short notice on a booking still ahead keeps its own answer.
  const soon = await booking(member.id, 0.05);
  const late = await post(member, `reservations/${soon.id}/cancel`);
  assert.deepEqual([late.status, late.body.error.code], [409, 'CANCELLATION_NOTICE_REQUIRED']);
});
