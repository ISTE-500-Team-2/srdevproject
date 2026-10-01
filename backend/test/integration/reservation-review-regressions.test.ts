import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { migrate, repositoryRoot } from '../../src/scripts/migrate.js';

const compatibility = '010_room_reservation_compatibility.sql';
const original = '010_room_reservation_conflicts.sql';
const originalChecksum = '93c890882c806560250651e8c037c0db76f94544267f8b5e58ff98b454a82def';
const equipmentConstraint = 'app_equipment_reservation_user_cooldown';
const roomConstraint = 'app_room_reservation_user_cooldown';
const minute = 60_000;
const hour = 60 * minute;
const origin = Date.parse('2030-01-10T10:00:00Z');

async function isolated(work: (pool: Pool) => Promise<void>) {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error('Explicit isolated PostgreSQL settings required');
  const database = 'arbor_reservation_review_' + randomBytes(6).toString('hex') + '_mvc_test';
  const admin = new Pool(), pool = new Pool({ database, statement_timeout: 10000 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await work(pool);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
}

// Build the actual old schema and migration ledger; do not infer compatibility
// by deleting new constraints from an already-upgraded database.
async function oldSchema(pool: Pool, alreadyApplied: boolean) {
  await pool.query(await readFile(path.join(repositoryRoot, 'ddl/collaboratory-db-create.sql'), 'utf8'));
  await pool.query('CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const directory = path.join(repositoryRoot, 'database/migrations');
  for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    if (name === compatibility || (!alreadyApplied && name === original)) continue;
    const sql = await readFile(path.join(directory, name), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO app_migration(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
  }
}
async function fixtures(pool: Pool) {
  const users = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
    VALUES('First','Member','first@example.invalid','unused','0000000000','active'),
          ('Second','Member','second@example.invalid','unused','0000000000','active') RETURNING userid`)).rows;
  const equipment = (await pool.query("INSERT INTO equipment(name,status) VALUES('Test printer','available') RETURNING equipmentid")).rows[0].equipmentid;
  return { first: users[0].userid as number, second: users[1].userid as number, equipment: equipment as number };
}
async function insert(pool: Pool, user: number, equipment: number | null, start: number,
  options: { room?: number; status?: string; flag?: boolean } = {}) {
  return (await pool.query(`INSERT INTO reservation(userid,equipmentid,roomid,location,starttime,endtime,status,cooldown_enforced)
    VALUES($1,$2,$3,'Test',$4::timestamptz AT TIME ZONE 'UTC',$5::timestamptz AT TIME ZONE 'UTC',$6,$7)
    RETURNING reservationid AS id,cooldown_enforced`,
  [user, equipment, options.room ?? null, new Date(start), new Date(start + hour), options.status ?? 'confirmed', options.flag ?? true])).rows[0];
}
async function rejectsCooldown(work: Promise<unknown>, constraint = equipmentConstraint) {
  await assert.rejects(work, (error: any) => error.code === '23P01' && error.constraint === constraint);
}

for (const alreadyApplied of [false, true]) test(`upgrade ${alreadyApplied ? 'original PR' : 'pre-PR'} database preserves bookings, denies and checksums`, async () => {
  await isolated(async pool => {
    await oldSchema(pool, alreadyApplied);
    const f = await fixtures(pool);
    if (alreadyApplied) await pool.query("SELECT setval('app_room_id_seq',500,true)");
    for (const year of [2020, 2030]) {
      const start = Date.parse(`${year}-01-10T10:00:00Z`);
      for (const [user, offset] of [[f.first, 0], [alreadyApplied ? f.second : f.first, hour]])
        await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
          VALUES($1,$2,'Old booking',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed')`,
        [user, f.equipment, new Date(start + offset), new Date(start + offset + hour)]);
    }
    if (!alreadyApplied)
      await pool.query(`INSERT INTO reservation(userid,location,starttime,endtime,status)
        VALUES($1,'Legacy resource-less record','2019-01-01','2019-01-02','cancelled')`, [f.first]);
    await pool.query(`INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
      SELECT r.roleid,p.permissionid,'room','personal',false FROM role r JOIN permission p ON p.permissionname='read'
      WHERE r.role='member'`);
    const bookingsBefore = (await pool.query('SELECT * FROM reservation ORDER BY reservationid')).rows;
    const ledgerBefore = (await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    await migrate(pool);
    const bookingsAfter = (await pool.query('SELECT * FROM reservation ORDER BY reservationid')).rows;
    assert.deepEqual(bookingsAfter.map(({ roomid, cooldown_enforced, ...r }) =>
      alreadyApplied ? { ...r, roomid } : r), bookingsBefore);
    assert.ok(bookingsAfter.every(r => r.cooldown_enforced === false));
    const ledger = (await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    for (const old of ledgerBefore) assert.deepEqual(ledger.find(r => r.name === old.name), old);
    assert.equal(ledger.find(r => r.name === original).checksum, originalChecksum);
    if (alreadyApplied)
      assert.equal((await pool.query("INSERT INTO room(name,location) VALUES('Sequence preservation','East wing') RETURNING roomid")).rows[0].roomid, 501);
    assert.equal((await pool.query(`SELECT isallowed FROM role_permission WHERE resourcename='room'
      AND roleid=(SELECT roleid FROM role WHERE role='member') AND scopetype='personal'`)).rows[0].isallowed, false);
    await migrate(pool);
    assert.deepEqual((await pool.query('SELECT * FROM reservation ORDER BY reservationid')).rows, bookingsAfter);
    assert.deepEqual((await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows, ledger);

    // New SQL writes must respect grandfathered rows in both booking orders.
    await rejectsCooldown(insert(pool, f.second, f.equipment, origin + 2 * hour));
    await rejectsCooldown(insert(pool, f.second, f.equipment, origin - hour - 14 * minute));
    const exact = await insert(pool, f.second, f.equipment, origin + 2 * hour + 15 * minute, { flag: false });
    assert.equal(exact.cooldown_enforced, true, 'caller cannot insert an exempt booking');
    const earlier = await insert(pool, f.second, f.equipment, origin - hour - 15 * minute);
    assert.equal(earlier.cooldown_enforced, true);
    await assert.rejects(insert(pool, f.second, f.equipment, origin), (e: any) => e.code === '23P01' && e.constraint === 'app_reservation_no_overlap');

    const legacy = bookingsAfter.find(r => r.starttime.getUTCFullYear() === 2030)!;
    await pool.query("UPDATE reservation SET statusdesc='Preserved booking' WHERE reservationid=$1", [legacy.reservationid]);
    assert.equal((await pool.query('SELECT cooldown_enforced FROM reservation WHERE reservationid=$1', [legacy.reservationid])).rows[0].cooldown_enforced, false);
    await rejectsCooldown(pool.query('UPDATE reservation SET userid=$2 WHERE reservationid=$1', [legacy.reservationid, f.second]));
    await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [legacy.reservationid]);
    await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [earlier.id]);
    const reused = await insert(pool, f.second, f.equipment, origin - 15 * minute);
    await rejectsCooldown(pool.query("UPDATE reservation SET status='confirmed' WHERE reservationid=$1", [legacy.reservationid]));
    await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [reused.id]);
    await pool.query('UPDATE reservation SET starttime=starttime+interval \'7 days\',endtime=endtime+interval \'7 days\' WHERE reservationid=$1', [legacy.reservationid]);
    assert.equal((await pool.query('SELECT cooldown_enforced FROM reservation WHERE reservationid=$1', [legacy.reservationid])).rows[0].cooldown_enforced, true);
    await pool.query('UPDATE reservation SET cooldown_enforced=false WHERE reservationid=$1', [legacy.reservationid]);
    assert.equal((await pool.query('SELECT cooldown_enforced FROM reservation WHERE reservationid=$1', [legacy.reservationid])).rows[0].cooldown_enforced, true);
    await pool.query("UPDATE reservation SET status='confirmed' WHERE reservationid=$1", [legacy.reservationid]);
  });
});

test('SQL cooldown prevents concurrent equipment bookings and preserves per-user room rules', async () => {
  await isolated(async pool => {
    await initializeDemo(pool);
    const f = await fixtures(pool);
    const first = await insert(pool, f.first, f.equipment, origin);
    for (const user of [f.first, f.second]) {
      await rejectsCooldown(insert(pool, user, f.equipment, origin + hour));
      await rejectsCooldown(insert(pool, user, f.equipment, origin + hour + 14 * minute));
      await rejectsCooldown(insert(pool, user, f.equipment, origin - hour - 14 * minute));
    }
    await insert(pool, f.second, f.equipment, origin + hour + 15 * minute);
    await insert(pool, f.second, f.equipment, origin - hour - 15 * minute);
    await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [first.id]);
    await insert(pool, f.second, f.equipment, origin);
    await assert.rejects(insert(pool, f.first, null, origin), (e: any) => e.code === '23514' && e.constraint === 'app_reservation_one_resource');

    const raceTime = origin + 10 * hour;
    const race = await Promise.allSettled([
      insert(pool, f.first, f.equipment, raceTime),
      insert(pool, f.second, f.equipment, raceTime + hour),
    ]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(race.filter(r => r.status === 'rejected' && r.reason.code === '23P01' && r.reason.constraint === equipmentConstraint).length, 1);
    const room = (await pool.query('SELECT roomid FROM room ORDER BY roomid LIMIT 1')).rows[0].roomid;
    await insert(pool, f.first, null, origin, { room });
    await rejectsCooldown(insert(pool, f.first, null, origin + hour, { room }), roomConstraint);
    await insert(pool, f.second, null, origin + hour, { room });
    await insert(pool, f.first, null, origin - hour - 15 * minute, { room });
    await insert(pool, f.first, null, origin + 2 * hour + 15 * minute, { room });
  });
});

test('grandfathered rooms enforce overlap globally and cooldown per user on changed bookings', async () => {
  await isolated(async pool => {
    await oldSchema(pool, true);
    const f = await fixtures(pool);
    const room = (await pool.query("INSERT INTO room(name,location) VALUES('Legacy room','East wing') RETURNING roomid")).rows[0].roomid;
    await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
      VALUES($1,$2,'East wing','2030-01-10 10:00','2030-01-10 11:00','confirmed'),
            ($3,$2,'East wing','2030-01-10 11:00','2030-01-10 12:00','confirmed')`, [f.first, room, f.second]);
    await migrate(pool);
    await rejectsCooldown(insert(pool, f.first, null, origin - hour, { room }), roomConstraint);
    await insert(pool, f.second, null, origin - hour, { room });
    await assert.rejects(insert(pool, f.second, null, origin, { room }), (e: any) => e.code === '23P01' && e.constraint === 'app_room_reservation_no_overlap');
    await insert(pool, f.first, null, origin + 2 * hour, { room });
  });
});

test('room discovery grants, explicit denies, instructor restriction and full-length room check-in', async () => {
  await isolated(async pool => {
    await initializeDemo(pool);
    const app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
      demoLogin: true, allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York' });
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/demo').send({ role: 'member' });
    assert.equal(login.status, 200);
    const user = login.body.data.user.id, csrf = login.body.data.csrfToken;
    agent.set('Authorization', 'Bearer ' + login.body.data.accessToken);
    assert.equal((await request(app).get('/api/rooms')).status, 401);
    for (const role of ['member', 'subscriber', 'day_pass', 'staff', 'instructor']) {
      await pool.query('DELETE FROM user_role WHERE userid=$1', [user]);
      await pool.query('INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role=$2', [user, role]);
      assert.equal((await agent.get('/api/rooms')).status, 200, role);
    }
    const room = (await agent.get('/api/rooms')).body.data[0].id;
    const instructorBooking = await agent.post('/api/reservations').set('X-CSRF-Token', csrf).send({
      roomId: room, startTime: new Date(origin).toISOString(), endTime: new Date(origin + hour).toISOString(),
    });
    assert.equal(instructorBooking.status, 403);
    assert.equal(instructorBooking.body.error.code, 'INSTRUCTOR_BOOKING_FORBIDDEN');
    await pool.query('DELETE FROM user_role WHERE userid=$1', [user]);
    await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'", [user]);
    await pool.query("UPDATE role_permission SET isallowed=false WHERE resourcename='room' AND roleid=(SELECT roleid FROM role WHERE role='member')");
    assert.equal((await agent.get('/api/rooms')).status, 403);
    await pool.query("UPDATE role_permission SET isallowed=true WHERE resourcename='room' AND roleid=(SELECT roleid FROM role WHERE role='member')");
    for (const waiver of (await agent.get('/api/me/waivers')).body.data)
      assert.equal((await agent.post(`/api/me/waivers/${waiver.id}/sign`).set('X-CSRF-Token', csrf).send({ accepted: true })).status, 200);
    const name = '陶'.repeat(100), location = '東'.repeat(100);
    const longRoom = (await pool.query("INSERT INTO room(name,location,status) VALUES($1,$2,'available') RETURNING roomid", [name, location])).rows[0].roomid;
    const now = Date.now();
    await insert(pool, user, null, now - 5 * minute, { room: longRoom });
    const checkin = await agent.post('/api/me/check-ins').set('X-CSRF-Token', csrf).send({ roomId: longRoom });
    assert.equal(checkin.status, 201);
    const stored = (await pool.query('SELECT roomid,location FROM check_in WHERE checkinid=$1', [checkin.body.data.id])).rows[0];
    assert.deepEqual(stored, { roomid: longRoom, location: `${name} - ${location}` });
  });
});

test('concurrent HTTP requests for adjacent equipment bookings return one cooldown rejection', async () => {
  await isolated(async pool => {
    await initializeDemo(pool);
    const app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
      demoLogin: true, allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York' });
    const users = [];
    for (const role of ['member', 'admin']) {
      const agent = request.agent(app);
      const login = await agent.post('/api/auth/demo').send({ role });
      assert.equal(login.status, 200);
      agent.set('Authorization', 'Bearer ' + login.body.data.accessToken);
      users.push({ agent, csrf: login.body.data.csrfToken });
    }
    const equipment = (await pool.query("SELECT equipmentid FROM equipment WHERE name='3D Printer'")).rows[0].equipmentid;
    const start = Date.now() + 5 * 86_400_000;
    const requests = users.map(({ agent, csrf }, i) => agent.post('/api/reservations').set('X-CSRF-Token', csrf).send({
      equipmentId: equipment,
      startTime: new Date(start + i * hour).toISOString(),
      endTime: new Date(start + (i + 1) * hour).toISOString(),
    }));
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal(responses.find(r => r.status === 409)!.body.error.code, 'RESERVATION_COOLDOWN');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM reservation')).rows[0].count, 1);
  });
});
