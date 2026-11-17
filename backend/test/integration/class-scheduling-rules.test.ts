import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = `arbor_class_rules_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({ idleTimeoutMillis: 1000 }), pool = new Pool({ database, idleTimeoutMillis: 1000 });
let server: Server, created = false, admin: any, member: any;
let workshop: number, trainingRoom: number, projectRoom: number, first: number, second: number;
const HOUR = 3600000, DAY = 24 * HOUR;
// 16:00 UTC is the same calendar day in New York, the facility's zone.
const day = new Date(Date.now() + 3 * DAY); day.setUTCHours(16, 0, 0, 0);
const at = (hours: number) => new Date(+day + hours * HOUR).toISOString();
const get = (path: string, actor = member) => request(server).get('/api' + path).set('Authorization', 'Bearer ' + actor.accessToken);
const post = (path: string, body: object = {}, actor = admin) => request(server).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken).send(body);
const body = (extra: object) => ({ title: 'Resin night', catalogId: workshop, instructorId: first, roomId: trainingRoom,
  capacity: 6, startsAt: at(0), endsAt: at(2), reason: 'Scheduling rules fixture', ...extra });
async function schedule(extra: object) {
  const r = await post('/classes', body(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function instructor(email: string) {
  const id = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
    VALUES('Class','Instructor',$1,'unused','0000000000','active') RETURNING userid`, [email])).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'", [id]);
  return id as number;
}
const room = async (name: string, capacity: number | null) => (await pool.query(
  "INSERT INTO room(name,location,status,capacity) VALUES($1,'Fixture','available',$2) RETURNING roomid", [name, capacity])).rows[0].roomid as number;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  server = createApp(pool, { jwtKey: randomBytes(32), host: '127.0.0.1', port: 8080, secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  admin = (await request(server).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(server).post('/api/auth/demo').send({ role: 'member' })).body.data;
  workshop = (await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
  trainingRoom = (await pool.query("SELECT roomid FROM room WHERE name='Training Room'")).rows[0].roomid;
  projectRoom = (await pool.query("SELECT roomid FROM room WHERE name='Project Room A'")).rows[0].roomid;
  first = await instructor('class-rules-first@example.invalid');
  second = await instructor('class-rules-second@example.invalid');
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
  await pool.end(); try { if (created) await owner.query(`DROP DATABASE "${database}"`); } finally { await owner.end(); }
});

test('one staff member schedules back-to-back classes in a room; a double booking is a room conflict', async () => {
  await schedule({});
  // The same instructor can teach the very next slot too.
  await schedule({ startsAt: at(2), endsAt: at(4) });
  const overlap = await post('/classes', body({ instructorId: second, startsAt: at(1), endsAt: at(3) }));
  assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
  assert.equal(overlap.body.error.code, 'RESERVATION_CONFLICT');
  const exempt = (await pool.query(`SELECT cooldown_enforced FROM reservation v JOIN app_training_class c ON c.reservation_id=v.reservationid`)).rows;
  assert.ok(exempt.length === 2 && exempt.every(r => r.cooldown_enforced === false));
  // A member's own room bookings still keep the per-member cooldown.
  const insert = (user: number, hours: number, enforced: boolean) => pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status,cooldown_enforced)
    VALUES($1,$2,'Test',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed',$5) RETURNING cooldown_enforced`,
    [user, projectRoom, at(hours), at(hours + 1), enforced]);
  assert.equal((await insert(member.user.id, 30, true)).rows[0].cooldown_enforced, true);
  await assert.rejects(insert(member.user.id, 31, true), (e: any) => e.constraint === 'app_room_reservation_user_cooldown');
  // Only a room booking can opt out; equipment bookings stay enforced.
  const equipment = (await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status,cooldown_enforced)
    SELECT $1,equipmentid,'Test',$2::timestamptz AT TIME ZONE 'UTC',$3::timestamptz AT TIME ZONE 'UTC','confirmed',false FROM equipment ORDER BY equipmentid LIMIT 1
    RETURNING cooldown_enforced`, [member.user.id, at(40), at(41)])).rows[0];
  assert.equal(equipment.cooldown_enforced, true);
});

test('an instructor cannot be booked to teach two classes at the same time', async () => {
  const clash = await post('/classes', body({ roomId: projectRoom, startsAt: at(1), endsAt: at(3), capacity: 5 }));
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(clash.body.error.code, 'INSTRUCTOR_CONFLICT');
  const other = await schedule({ instructorId: second, roomId: projectRoom, startsAt: at(1), endsAt: at(3), capacity: 5 });
  // A cancelled class frees the instructor again.
  assert.equal((await post(`/classes/${other.id}/cancel`, { expectedRevision: other.revision, reason: 'Moved' })).status, 200);
  await schedule({ instructorId: second, roomId: projectRoom, startsAt: at(1), endsAt: at(3), capacity: 5, title: 'Moved back' });
});

test('a room with no seat count entered takes classes of up to 15', async () => {
  const open = await room('No seat count', null);
  await schedule({ roomId: open, capacity: 15, startsAt: at(24), endsAt: at(25) });
  const tooBig = await post('/classes', body({ roomId: open, capacity: 16, startsAt: at(26), endsAt: at(27) }));
  assert.equal(tooBig.body.error.code, 'CAPACITY_LIMIT');
  const small = await room('Small room', 4);
  const over = await post('/classes', body({ roomId: small, capacity: 5, startsAt: at(26), endsAt: at(27) }));
  assert.equal(over.body.error.code, 'CAPACITY_LIMIT');
});

test('registration checks the membership or day pass over the class time, not today', async () => {
  const passRoom = await room('Pass room', 10);
  const onPassDay = await schedule({ roomId: passRoom, startsAt: at(48), endsAt: at(50), title: 'On the pass day' });
  const nextDay = await schedule({ roomId: passRoom, startsAt: at(72), endsAt: at(74), title: 'The day after' });
  const passDate = new Date(+day + 48 * HOUR).toISOString().slice(0, 10);
  const userid = member.user.id;
  // No membership today; a day pass bought for the class day.
  await pool.query("UPDATE user_membership SET status='suspended' WHERE userid=$1", [userid]);
  await pool.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,$2,'active')", [userid, passDate]);
  const listed = (await get('/classes')).body.data;
  assert.equal(listed.find((c: any) => c.id === onPassDay.id).myEntitled, true);
  assert.equal(listed.find((c: any) => c.id === nextDay.id).myEntitled, false);
  const early = await post(`/classes/${onPassDay.id}/enroll`, {}, member);
  assert.equal(early.status, 200, JSON.stringify(early.body));
  const uncovered = await post(`/classes/${nextDay.id}/enroll`, {}, member);
  assert.equal(uncovered.status, 403);
  assert.equal(uncovered.body.error.code, 'ENTITLEMENT_REQUIRED');
  // A membership active today that ends before the class does not cover it.
  await pool.query(`UPDATE user_membership SET status='active',end_date=(NOW()+interval '1 day') AT TIME ZONE 'UTC' WHERE userid=$1`, [userid]);
  const lapsing = await post(`/classes/${nextDay.id}/enroll`, {}, member);
  assert.equal(lapsing.status, 403, JSON.stringify(lapsing.body));
  assert.equal(lapsing.body.error.code, 'ENTITLEMENT_REQUIRED');
  await pool.query(`UPDATE user_membership SET end_date=(NOW()+interval '30 days') AT TIME ZONE 'UTC' WHERE userid=$1`, [userid]);
  assert.equal((await get('/classes')).body.data.find((c: any) => c.id === nextDay.id).myEntitled, true);

  // Attendance still to record is counted for staff and the class's instructor only.
  assert.equal((await get('/classes', admin)).body.data.find((c: any) => c.id === onPassDay.id).pendingAttendance, 1);
  assert.equal(listed.find((c: any) => c.id === onPassDay.id).pendingAttendance, null);
  await pool.query('UPDATE app_training_class SET instructor_id=$2 WHERE id=$1', [nextDay.id, userid]);
  assert.equal((await get('/classes')).body.data.find((c: any) => c.id === nextDay.id).pendingAttendance, 0);
});

test('a class cannot be cancelled once it has started, or cancelled twice', async () => {
  const cancelRoom = await room('Cancel room', 10);
  const started = await schedule({ roomId: cancelRoom, instructorId: second, startsAt: at(100), endsAt: at(101), title: 'Started' });
  await pool.query(`INSERT INTO app_training_enrollment(class_id,user_id,status) VALUES($1,$2,'attended')`, [started.id, member.user.id]);
  await pool.query(`UPDATE reservation SET starttime=(NOW()-interval '1 hour') AT TIME ZONE 'UTC',endtime=(NOW()+interval '1 hour') AT TIME ZONE 'UTC'
    WHERE reservationid=$1`, [started.reservation_id]);
  const late = await post(`/classes/${started.id}/cancel`, { expectedRevision: started.revision, reason: 'Too late' });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.error.code, 'CLASS_CLOSED');
  const kept = (await pool.query(`SELECT c.status,c.revision,v.status AS booking,e.status AS attendance FROM app_training_class c
    JOIN reservation v ON v.reservationid=c.reservation_id JOIN app_training_enrollment e ON e.class_id=c.id WHERE c.id=$1`, [started.id])).rows[0];
  assert.deepEqual(kept, { status: 'scheduled', revision: started.revision, booking: 'confirmed', attendance: 'attended' });

  const upcoming = await schedule({ roomId: cancelRoom, instructorId: second, startsAt: at(102), endsAt: at(103), title: 'Upcoming' });
  const cancelled = await post(`/classes/${upcoming.id}/cancel`, { expectedRevision: upcoming.revision, reason: 'Instructor out sick' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const again = await post(`/classes/${upcoming.id}/cancel`, { expectedRevision: cancelled.body.data.revision, reason: 'Again' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'CLASS_CLOSED');
});
