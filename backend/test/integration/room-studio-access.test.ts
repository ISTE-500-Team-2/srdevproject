import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { transaction } from '../../src/db.js';
import type { ReaderKind } from '../../src/readerRegistry.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { evaluateReaderAccess } from '../../src/services/ReaderEligibility.js';

const tz = 'America/New_York';
const database = `arbor_room_studio_${randomBytes(6).toString('hex')}_mvc_test`;
const admin = new Pool(), pool = new Pool({ database });
const secret = randomBytes(32).toString('hex'), hashKey = randomBytes(32).toString('hex'), uid = '04111213141516';
let app: ReturnType<typeof createApp>, created = false;
let staffToken: string, staffCsrf: string, adminId: number;
let memberToken: string, memberCsrf: string, memberId: number;
let room: number, studio: number, studioName: string;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL configuration required.');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  room = (await pool.query("INSERT INTO room(name,location,status,buildingid) VALUES('Class room','Upstairs','available',1) RETURNING roomid")).rows[0].roomid;
  ({ id: studio, name: studioName } = (await pool.query('SELECT id,name FROM app_studio WHERE active ORDER BY id LIMIT 1')).rows[0]);
  await pool.query("UPDATE app_studio SET monthly_cents=20000,cancellation_policy='no_refunds',policy_confirmed=true");
  app = createApp(pool, {
    jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: [], timeZone: tz,
    // A configured studio reader is imported into the registry, so the widened kind check is exercised.
    devices: { cardHashKey: hashKey, readers: [{ id: 'studio', secret, kind: 'studio', resourceId: studio }] },
  });
  const staff = await request(app).post('/api/auth/demo').send({ role: 'admin' });
  staffToken = staff.body.data.accessToken; staffCsrf = staff.body.data.csrfToken; adminId = staff.body.data.user.id;
  const member = await request(app).post('/api/auth/demo').send({ role: 'member' });
  memberToken = member.body.data.accessToken; memberCsrf = member.body.data.csrfToken; memberId = member.body.data.user.id;
  for (const id of [adminId, memberId]) await eligible(id);
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });

/** A current membership and every required policy signed: everything but the booking itself. */
async function eligible(userId: number) {
  await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
    SELECT $1,tierid,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active'
    FROM membership_tiers WHERE kind='membership'
      AND NOT EXISTS(SELECT 1 FROM user_membership WHERE userid=$1 AND status='active' AND end_date>NOW() AT TIME ZONE 'UTC')
    ORDER BY tierid LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval)
    SELECT $1,waiverid,NOW() AT TIME ZONE 'UTC',true FROM waiver w WHERE isactive AND required
      AND NOT EXISTS(SELECT 1 FROM user_waiver uw WHERE uw.userid=$1 AND uw.waiverid=w.waiverid)`, [userId]);
}
async function person(name: string, roles: string[] = ['member']) {
  const id = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,phone,password,status,accessstatus,email_confirmed)
    VALUES($1,'Tester',$2,'0000000000','x','active','active',true) RETURNING userid`, [name, `${randomUUID()}@example.invalid`])).rows[0].userid;
  for (const role of roles)
    await pool.query('INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role=$2', [id, role]);
  await eligible(id);
  return id as number;
}
/** The reader verdict every signed tap and staff preview uses. */
function verdict(kind: ReaderKind, resourceId: number, userId: number) {
  return transaction(pool, db => evaluateReaderAccess(db, tz, { kind, resourceId }, userId));
}
async function reason(kind: ReaderKind, resourceId: number, userId: number) {
  return (await verdict(kind, resourceId, userId)).reason;
}
const staffPost = (path: string, body: object) =>
  request(app).post('/api' + path).set('Authorization', 'Bearer ' + staffToken).set('X-CSRF-Token', staffCsrf).set('X-Account-Subject', String(adminId)).send(body);
const memberPost = (path: string, body: object) =>
  request(app).post('/api' + path).set('Authorization', 'Bearer ' + memberToken).set('X-CSRF-Token', memberCsrf).send(body);

test('a class room admits its instructor and registered students during the class, never the scheduler', async () => {
  const instructor = await person('Ines', ['instructor']);
  const dropped = await person('Dora'), absent = await person('Abe'), outsider = await person('Olga');
  const catalogId = (await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
  const scheduled = await staffPost('/classes', {
    title: 'Room access class', catalogId, instructorId: instructor, roomId: room, capacity: 10,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    reason: 'Scheduled for room access test',
  });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const classId = scheduled.body.data.id, slot = scheduled.body.data.reservation_id;
  // The booking is held by the staff member who scheduled the class.
  assert.equal((await pool.query('SELECT userid FROM reservation WHERE reservationid=$1', [slot])).rows[0].userid, adminId);
  const enrolled = await memberPost(`/classes/${classId}/enroll`, {});
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  await pool.query(`INSERT INTO app_training_enrollment(class_id,user_id,status) VALUES($1,$2,'cancelled'),($1,$3,'no_show')`, [classId, dropped, absent]);

  // Before the class starts, nobody gets in on its booking.
  assert.equal(await reason('room', room, instructor), 'RESERVATION_REQUIRED');
  assert.equal(await reason('room', room, memberId), 'RESERVATION_REQUIRED');
  await pool.query(`UPDATE reservation SET starttime=(NOW()-INTERVAL '10 minutes') AT TIME ZONE 'UTC',
    endtime=(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC' WHERE reservationid=$1`, [slot]);

  for (const id of [instructor, memberId]) {
    const v = await verdict('room', room, id);
    assert.equal(v.reason, 'ELIGIBLE', String(id));
    assert.equal(v.reservationId, slot);
  }
  for (const [id, who] of [[adminId, 'scheduler'], [dropped, 'withdrawn'], [absent, 'no-show'], [outsider, 'outsider']] as const)
    assert.equal(await reason('room', room, id), 'RESERVATION_REQUIRED', who);
  // A different room at the same time is not opened by the class.
  const otherRoom = (await pool.query("INSERT INTO room(name,location,status,buildingid) VALUES('Other room','Down','available',1) RETURNING roomid")).rows[0].roomid;
  assert.equal(await reason('room', otherRoom, memberId), 'RESERVATION_REQUIRED');
  // A scheduler who teaches the class gets in as its instructor.
  await pool.query('UPDATE app_training_class SET instructor_id=$2 WHERE id=$1', [classId, adminId]);
  assert.equal(await reason('room', room, adminId), 'ELIGIBLE');
  assert.equal(await reason('room', room, instructor), 'RESERVATION_REQUIRED', 'a replaced instructor loses access');
  await pool.query('UPDATE app_training_class SET instructor_id=$2 WHERE id=$1', [classId, instructor]);
  await pool.query(`UPDATE app_training_enrollment SET status='attended' WHERE class_id=$1 AND user_id=$2`, [classId, memberId]);
  assert.equal(await reason('room', room, memberId), 'ELIGIBLE', 'attendance keeps access');

  // Every other check still applies to class access.
  await pool.query("UPDATE user_membership SET status='suspended' WHERE userid=$1", [memberId]);
  assert.equal(await reason('room', room, memberId), 'ENTITLEMENT_REQUIRED');
  await pool.query("UPDATE user_membership SET status='active' WHERE userid=$1", [memberId]);
  await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1', [instructor]);
  assert.equal(await reason('room', room, instructor), 'WAIVER_REQUIRED');
  await pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1', [instructor]);
  await pool.query("UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1", [memberId]);
  assert.equal(await reason('room', room, memberId), 'ACCOUNT_BLOCKED');
  await pool.query("UPDATE \"user\" SET accessstatus='active' WHERE userid=$1", [memberId]);
  await pool.query("UPDATE room SET status='unavailable' WHERE roomid=$1", [room]);
  assert.equal(await reason('room', room, instructor), 'RESOURCE_UNAVAILABLE');
  await pool.query("UPDATE room SET status='available' WHERE roomid=$1", [room]);

  // A minor's seat opens the room only with the sponsor who registered them, present in the building.
  const sponsor = await person('Sam');
  await pool.query("UPDATE \"user\" SET dob=(NOW()-INTERVAL '40 years')::date WHERE userid=$1", [sponsor]);
  const minor = await person('Mina');
  await pool.query("UPDATE \"user\" SET dob=(NOW()-INTERVAL '15 years')::date WHERE userid=$1", [minor]);
  await pool.query('INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2)', [minor, sponsor]);
  await pool.query('INSERT INTO app_facility_visit(user_id,building_id) VALUES($1,1)', [sponsor]);
  await pool.query(`INSERT INTO app_training_enrollment(class_id,user_id,status) VALUES($1,$2,'enrolled')`, [classId, minor]);
  assert.equal(await reason('room', room, minor), 'SPONSOR_BOOKING_REQUIRED');
  await pool.query('UPDATE app_training_enrollment SET sponsor_id=$3 WHERE class_id=$1 AND user_id=$2', [classId, minor, sponsor]);
  assert.equal(await reason('room', room, minor), 'ELIGIBLE');

  // A cancelled class, or its cancelled booking, opens nothing.
  await pool.query("UPDATE app_training_class SET status='cancelled' WHERE id=$1", [classId]);
  assert.equal(await reason('room', room, instructor), 'RESERVATION_REQUIRED');
  assert.equal(await reason('room', room, memberId), 'RESERVATION_REQUIRED');
  await pool.query("UPDATE app_training_class SET status='scheduled' WHERE id=$1", [classId]);
  await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [slot]);
  assert.equal(await reason('room', room, memberId), 'RESERVATION_REQUIRED');
  await pool.query("UPDATE reservation SET status='cancelled',endtime=NOW() AT TIME ZONE 'UTC' WHERE reservationid=$1", [slot]);
});

test('members book, list and cancel a free room booking, which opens the room only during it', async () => {
  // The suspension above ended the member's earlier session.
  const login = await request(app).post('/api/auth/demo').send({ role: 'member' });
  memberToken = login.body.data.accessToken; memberCsrf = login.body.data.csrfToken;
  const hour = 3_600_000, start = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / hour) * hour);
  const booked = await memberPost('/reservations', {
    roomId: room, startTime: start.toISOString(), endTime: new Date(start.getTime() + 2 * hour).toISOString(),
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.data.status, 'confirmed');
  assert.equal(booked.body.data.resourceType, 'room');
  assert.equal(booked.body.data.amountCents, null, 'rooms are not priced');
  assert.equal((await pool.query('SELECT payment_id FROM reservation WHERE reservationid=$1', [booked.body.data.id])).rows[0].payment_id, null);
  const mine = (await request(app).get('/api/rooms').set('Authorization', 'Bearer ' + memberToken)).body.data.find((r: { id: number }) => r.id === room);
  assert.deepEqual(mine.occupied.filter((s: { mine: boolean }) => s.mine).length, 1);
  assert.deepEqual(Object.keys(mine.occupied[0]).sort(), ['endTime', 'mine', 'startTime'], 'no other booking details are shared');
  const theirs = (await request(app).get('/api/rooms').set('Authorization', 'Bearer ' + staffToken)).body.data.find((r: { id: number }) => r.id === room);
  assert.equal(theirs.occupied.some((s: { mine: boolean }) => s.mine), false);
  const list = await request(app).get('/api/reservations').set('Authorization', 'Bearer ' + memberToken);
  assert.ok(list.body.data.some((r: { id: number }) => r.id === booked.body.data.id));
  // Back-to-back bookings by the same member need the room gap; overlapping anyone's is refused.
  const tooSoon = await memberPost('/reservations', {
    roomId: room, startTime: new Date(start.getTime() + 2 * hour).toISOString(), endTime: new Date(start.getTime() + 3 * hour).toISOString(),
  });
  assert.equal(tooSoon.body.error?.code, 'RESERVATION_COOLDOWN');
  assert.equal(await reason('room', room, memberId), 'RESERVATION_REQUIRED', 'not before the booking starts');
  const cancelled = await memberPost(`/reservations/${booked.body.data.id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
});

test('a studio reader opens only for a current paid rental of that studio', async () => {
  const today = (await pool.query(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0].d as string;
  const day = (offset: number) => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
  const otherStudio = (await pool.query('SELECT id FROM app_studio WHERE active AND id<>$1 ORDER BY id LIMIT 1', [studio])).rows[0].id;
  const rent = async (userId: number, studioId: number, from: string, to: string, status = 'confirmed', payment = 'paid') =>
    (await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_status,payment_method,request_key)
      VALUES($1,$2,$3,$4,20000,'no_refunds',$5,$6,'manual',$7) RETURNING id`, [studioId, userId, from, to, status, payment, randomUUID()])).rows[0].id as number;

  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED');
  // Another member's rental, or the member's rental of another studio, does not count.
  const neighbour = await person('Nell');
  const theirs = await rent(neighbour, studio, day(-3), day(20));
  await rent(memberId, otherStudio, day(-3), day(20));
  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED');
  assert.equal(await reason('studio', studio, neighbour), 'ELIGIBLE');
  await pool.query("UPDATE app_studio_rental SET status='cancelled' WHERE id=$1", [theirs]);
  assert.equal(await reason('studio', studio, neighbour), 'STUDIO_RENTAL_REQUIRED');

  // An unpaid hold, then a rental that ended yesterday or starts tomorrow, do not open it.
  const rental = await rent(memberId, studio, day(-30), day(0), 'pending', 'unpaid');
  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED');
  await pool.query("UPDATE app_studio_rental SET status='confirmed',payment_status='paid' WHERE id=$1", [rental]);
  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED', 'ends_on is the first day after the rental');
  await pool.query('UPDATE app_studio_rental SET starts_on=$2,ends_on=$3 WHERE id=$1', [rental, day(1), day(30)]);
  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED');
  await pool.query('UPDATE app_studio_rental SET starts_on=$2,ends_on=$3 WHERE id=$1', [rental, day(0), day(1)]);
  assert.equal(await reason('studio', studio, memberId), 'ELIGIBLE', 'the last day of a rental still opens it');
  await pool.query("UPDATE app_studio_rental SET payment_status='refunded' WHERE id=$1", [rental]);
  assert.equal(await reason('studio', studio, memberId), 'STUDIO_RENTAL_REQUIRED');
  await pool.query("UPDATE app_studio_rental SET payment_status='paid',ends_on=$2 WHERE id=$1", [rental, day(25)]);

  // The tap is signed, short-leased and recorded as a check-in at the studio.
  await pool.query('INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,$3,$1)',
    [memberId, createHmac('sha256', hashKey).update(uid).digest('hex'), 'Studio card']);
  const body = JSON.stringify({ uid, eventId: randomUUID(), checkIn: true, renewal: false }), stamp = String(Date.now());
  const tap = await request(app).post('/api/devices/decision').set('Content-Type', 'application/json')
    .set('X-Reader-ID', 'studio').set('X-Reader-Timestamp', stamp)
    .set('X-Reader-Signature', createHmac('sha256', secret).update(stamp + '\n' + body).digest('hex')).send(body);
  assert.equal(tap.status, 200, JSON.stringify(tap.body));
  assert.equal(tap.body.data.allowed, true, JSON.stringify(tap.body));
  assert.ok(tap.body.data.leaseSeconds <= 5);
  const stored = (await pool.query("SELECT location,buildingid,roomid,equipmentid FROM check_in WHERE userid=$1 AND origin='nfc' ORDER BY checkinid DESC LIMIT 1", [memberId])).rows[0];
  assert.deepEqual(stored, { location: studioName, buildingid: 1, roomid: null, equipmentid: null });

  // The usual account, entitlement, policy and availability checks still apply.
  await pool.query("UPDATE user_membership SET status='suspended' WHERE userid=$1", [memberId]);
  assert.equal(await reason('studio', studio, memberId), 'ENTITLEMENT_REQUIRED');
  await pool.query("UPDATE user_membership SET status='active' WHERE userid=$1", [memberId]);
  await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1', [memberId]);
  assert.equal(await reason('studio', studio, memberId), 'WAIVER_REQUIRED');
  await pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1', [memberId]);
  await pool.query("UPDATE \"user\" SET accessstatus='revoked' WHERE userid=$1", [memberId]);
  assert.equal(await reason('studio', studio, memberId), 'ACCOUNT_BLOCKED');
  await pool.query("UPDATE \"user\" SET accessstatus='active' WHERE userid=$1", [memberId]);
  await pool.query('UPDATE app_studio SET active=false WHERE id=$1', [studio]);
  assert.equal(await reason('studio', studio, memberId), 'RESOURCE_UNAVAILABLE');
  await pool.query('UPDATE app_studio SET active=true WHERE id=$1', [studio]);
  await pool.query("UPDATE building SET status='unavailable' WHERE buildingid=1");
  assert.equal(await reason('studio', studio, memberId), 'RESOURCE_UNAVAILABLE');
  await pool.query("UPDATE building SET status='available' WHERE buildingid=1");
  assert.equal(await reason('studio', 999_999, memberId), 'RESOURCE_UNAVAILABLE');

  // A minor's rental needs the sponsor it was booked with.
  const sponsor = await person('Sid');
  await pool.query("UPDATE \"user\" SET dob=(NOW()-INTERVAL '40 years')::date WHERE userid=$1", [sponsor]);
  const minor = await person('Milo');
  await pool.query("UPDATE \"user\" SET dob=(NOW()-INTERVAL '15 years')::date WHERE userid=$1", [minor]);
  await pool.query('INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2)', [minor, sponsor]);
  await pool.query('INSERT INTO app_facility_visit(user_id,building_id) VALUES($1,1)', [sponsor]);
  const thirdStudio = (await pool.query('SELECT id FROM app_studio WHERE active AND id NOT IN ($1,$2) ORDER BY id LIMIT 1', [studio, otherStudio])).rows[0].id;
  const minorRental = await rent(minor, thirdStudio, day(-1), day(10));
  assert.equal(await reason('studio', thirdStudio, minor), 'SPONSOR_BOOKING_REQUIRED');
  await pool.query('INSERT INTO app_minor_studio_booking(rental_id,adult_id) VALUES($1,$2)', [minorRental, sponsor]);
  assert.equal(await reason('studio', thirdStudio, minor), 'ELIGIBLE');
});

test('staff can attach a reader to an active studio and see it named in the reader list', async () => {
  const resources = await request(app).get('/api/admin/access/resources').set('Authorization', 'Bearer ' + staffToken);
  assert.equal(resources.status, 200);
  assert.ok(resources.body.data.some((r: { kind: string; id: number }) => r.kind === 'studio' && r.id === studio));
  const added = await staffPost('/admin/access/readers', { id: 'studio-door', name: 'Studio door', kind: 'studio', resourceId: studio, reason: 'New studio reader' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.data.kind, 'studio');
  const missing = await staffPost('/admin/access/readers', { id: 'studio-ghost', name: 'Ghost', kind: 'studio', resourceId: 999_999, reason: 'Missing studio' });
  assert.equal(missing.status, 404);
  const bogus = await staffPost('/admin/access/readers', { id: 'bogus', name: 'Bogus', kind: 'locker', resourceId: studio, reason: 'Unknown kind' });
  assert.deepEqual([bogus.status, bogus.body.error?.code], [400, 'INVALID_READER']);
  const readers = await request(app).get('/api/admin/access/readers').set('Authorization', 'Bearer ' + staffToken);
  assert.equal(readers.status, 200, JSON.stringify(readers.body));
  assert.equal(readers.body.data.readers.find((r: { id: string }) => r.id === 'studio-door').resourceName, studioName);
});
