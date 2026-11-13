import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MemberModel } from '../../src/models/MemberModel.js';
import { repositoryRoot } from '../../src/scripts/migrate.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_origin_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const secret = randomBytes(32).toString('hex');
let created = false, app: ReturnType<typeof createApp>, admin: any, member: any, room: number;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  room = (await pool.query("INSERT INTO room(name,location,status) VALUES('Origin room','Test','available') RETURNING roomid")).rows[0].roomid;
  app = createApp(pool, {
    jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: [], timeZone: 'America/New_York',
    devices: { cardHashKey: randomBytes(32).toString('hex'), readers: [{ id: 'origin', secret, kind: 'room', resourceId: room }] },
  });
  admin = (await request(app).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(app).post('/api/auth/demo').send({ role: 'member' })).body.data;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

const insert = (userId: number, location: string, statusdesc: string, origin: string | null) => pool.query(
  `INSERT INTO check_in(userid,location,checkintime,status,statusdesc,origin)
  VALUES($1,$2,NOW() AT TIME ZONE 'UTC','approved',$3,$4) RETURNING checkinid`, [userId, location, statusdesc, origin]);
const origins = async (ids: number[]) => (await pool.query(
  'SELECT checkinid,origin FROM check_in WHERE checkinid=ANY($1) ORDER BY checkinid', [ids])).rows.map(row => row.origin);
const today = async () => {
  const day = (await pool.query("SELECT to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day")).rows[0].day;
  const r = await request(app).get(`/api/admin/reports?from=${day}&to=${day}&period=daily`).set('Authorization', 'Bearer ' + admin.accessToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.checkedInToday as { userId: number; location: string; method: string }[];
};

test('migration 040 backfills reader check-ins once and leaves other rows to the fallback', async () => {
  const sql = await readFile(path.join(repositoryRoot, 'database/migrations/040_check_in_origin.sql'), 'utf8');
  // Recreate the pre-040 table shape and replay the migration against legacy rows.
  await pool.query('ALTER TABLE check_in DROP COLUMN origin');
  try {
    const legacy: number[] = [];
    for (const [location, statusdesc] of [
      ['Front door', 'Authenticated NFC eligibility decision'],
      ['Side door', 'legacy nfc tap'],
      ['Portal', 'Eligibility verified by member portal'],
      ['Desk', null],
    ]) legacy.push((await pool.query(
      `INSERT INTO check_in(userid,location,checkintime,status,statusdesc) VALUES($1,$2,NOW() AT TIME ZONE 'UTC','approved',$3) RETURNING checkinid`,
      [member.user.id, location, statusdesc])).rows[0].checkinid);
    const auditsBefore = Number((await pool.query("SELECT COUNT(*) FROM app_staff_audit WHERE action='check_in.update'")).rows[0].count);
    await pool.query(sql);
    assert.deepEqual(await origins(legacy), ['nfc', 'nfc', null, null]);
    const auditsAfter = Number((await pool.query("SELECT COUNT(*) FROM app_staff_audit WHERE action='check_in.update'")).rows[0].count);
    assert.equal(auditsAfter - auditsBefore, 2, 'only the backfilled reader rows are rewritten');
    const recent = await new MemberModel(pool).recentCheckIns(member.user.id);
    assert.deepEqual(Object.fromEntries(recent.map(row => [row.location, row.method])),
      { 'Front door': 'nfc', 'Side door': 'nfc', Portal: 'portal', Desk: 'portal' });
  } finally {
    await pool.query('DELETE FROM check_in');
  }
});

test('origin is constrained to nfc or portal and may be absent', async () => {
  await assert.rejects(insert(member.user.id, 'Kiosk', 'Kiosk tap', 'kiosk'), { code: '23514' });
  await assert.rejects(insert(member.user.id, 'Kiosk', 'Kiosk tap', 'NFC'), { code: '23514' });
  const row = (await insert(member.user.id, 'Old release', 'Authenticated NFC eligibility decision', null)).rows[0].checkinid;
  assert.deepEqual(await origins([row]), [null]);
  await pool.query('DELETE FROM check_in');
});

test('readers use the stored origin, not the status wording, and fall back only when it is absent', async () => {
  const [a, b, c] = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
    SELECT 'Origin','Visitor '||g,'origin-'||g||'@example.invalid','x','0000000000','active' FROM generate_series(1,3) g RETURNING userid`))
    .rows.map(row => row.userid as number);
  await insert(a!, 'Reworded reader', 'Card accepted at the door', 'nfc');
  await insert(b!, 'Portal mentioning NFC', 'Member portal (no NFC card needed)', 'portal');
  await insert(c!, 'Previous release', 'Authenticated NFC eligibility decision', null);
  const byUser = Object.fromEntries((await today()).map(person => [person.userId, person.method]));
  assert.deepEqual([byUser[a!], byUser[b!], byUser[c!]], ['nfc', 'portal', 'nfc']);
  for (const [userId, method] of [[a, 'nfc'], [b, 'portal'], [c, 'nfc']] as const)
    assert.equal((await new MemberModel(pool).recentCheckIns(userId!))[0]!.method, method);
  await pool.query('DELETE FROM check_in');
});

test('portal and reader check-ins record their origin', async () => {
  const portal = await new MemberModel(pool).createCheckIn(member.user.id, 'Origin room', room);
  assert.deepEqual(await origins([portal.id]), ['portal']);

  const waivers = (await request(app).get('/api/me/waivers').set('Authorization', 'Bearer ' + member.accessToken)).body.data;
  for (const waiver of waivers)
    assert.equal((await request(app).post(`/api/me/waivers/${waiver.id}/sign`).set('Authorization', 'Bearer ' + member.accessToken)
      .set('X-CSRF-Token', member.csrfToken).send(waiverAcceptance(waiver))).status, 200);
  const uid = '04ABCDEF012345';
  const card = await request(app).post('/api/admin/access/cards').set('Authorization', 'Bearer ' + admin.accessToken)
    .set('X-CSRF-Token', admin.csrfToken).send({ uid, userId: member.user.id, label: 'Origin card', reason: 'Verified identity' });
  assert.equal(card.status, 201, JSON.stringify(card.body));
  await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'Origin room',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '10 minutes') AT TIME ZONE 'UTC','confirmed')`,
  [member.user.id, room]);
  const body = JSON.stringify({ eventId: randomUUID(), uid, renewal: false, checkIn: true }), stamp = String(Date.now());
  const tap = await request(app).post('/api/devices/decision').set('Content-Type', 'application/json').set('X-Reader-ID', 'origin')
    .set('X-Reader-Timestamp', stamp).set('X-Reader-Signature', createHmac('sha256', secret).update(stamp + '\n' + body).digest('hex')).send(body);
  assert.equal(tap.body.data.allowed, true, JSON.stringify(tap.body));
  const reader = (await pool.query("SELECT origin FROM check_in WHERE userid=$1 AND location='origin'", [member.user.id])).rows;
  assert.deepEqual(reader, [{ origin: 'nfc' }]);
});
