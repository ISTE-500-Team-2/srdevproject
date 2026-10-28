import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { before, after, test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReaderRegistry } from '../../src/readerRegistry.js';
import { SessionModel } from '../../src/models/SessionModel.js';
import { deviceDecision } from '../../src/deviceAccess.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_maintenance_${randomBytes(6).toString('hex')}_mvc_test`;
const admin = new Pool(), pool = new Pool({ database });
const jwtKey = randomBytes(32);
const tz = 'America/New_York', secret = randomBytes(32).toString('hex'), hashKey = randomBytes(32).toString('hex'), uid = '04010203040506';
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let app: ReturnType<typeof createApp>, administrator: Session, staff: Session, member: Session, readerMachine: number;
let created = false;
const devices = { cardHashKey: hashKey, readers: [] as { id: string; secret: string; kind: 'equipment'; resourceId: number }[] };
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  readerMachine = await machine('Reader machine');
  devices.readers.push({ id: 'maintenance-reader', secret, kind: 'equipment', resourceId: readerMachine });
  app = createApp(pool, { jwtKey, port: 8080, host: '127.0.0.1', secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: tz, devices });
  const login = async (role: string) => (await request(app).post('/api/auth/demo').send({ role })).body.data;
  administrator = await login('admin'); member = await login('member');
  const staffId = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status,primary_role) VALUES('Equipment','Staff','equipment-staff@example.invalid','unused','0000000000','active','staff') RETURNING userid`)).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'", [staffId]);
  const staffSession = await new SessionModel(pool, jwtKey).create(staffId, false);
  staff = { accessToken: staffSession.token, csrfToken: staffSession.csrfToken, user: { id: staffId } };
  for (const w of (await get('/me/waivers', member)).body.data)
    assert.equal((await post(`/me/waivers/${w.id}/sign`, waiverAcceptance(w), member)).status, 200);
  await pool.query('INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,$3,$1)', [member.user.id, createHmac('sha256', hashKey).update(uid).digest('hex'), 'Maintenance test']);
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });
function get(path: string, who = administrator) { return request(app).get('/api' + path).set('Authorization', 'Bearer ' + who.accessToken); }
function post(path: string, body: unknown, who = administrator) { return request(app).post('/api' + path).set('Authorization', 'Bearer ' + who.accessToken).set('X-CSRF-Token', who.csrfToken).send(body); }
const outage = { expectedRevision: 1, reason: 'repair', stopped: true, note: 'Staff-only spindle diagnosis' };
async function machine(name = 'Maintenance machine', status = 'available') {
  return (await pool.query('INSERT INTO equipment(name,status,hourlyrate,waiverrequired) VALUES($1,$2,12,false) RETURNING equipmentid', [name, status])).rows[0].equipmentid as number;
}
async function booking(id: number, days = 2) {
  return (await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Makerspace',(NOW()+$3 * INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+$3 * INTERVAL '1 day'+INTERVAL '1 hour') AT TIME ZONE 'UTC','confirmed') RETURNING reservationid AS id,revision`, [member.user.id, id, days])).rows[0];
}
async function notifications(id: number) { return (await pool.query("SELECT * FROM app_notification_outbox WHERE payload->>'reservationId'=$1", [String(id)])).rows; }
function scan(target = app) {
  const body = JSON.stringify({ uid, eventId: randomUUID(), checkIn: true, renewal: false }), stamp = String(Date.now());
  return request(target).post('/api/devices/decision').set('Content-Type', 'application/json').set('X-Reader-ID', 'maintenance-reader').set('X-Reader-Timestamp', stamp)
    .set('X-Reader-Signature', createHmac('sha256', secret).update(stamp + '\n' + body).digest('hex')).send(body);
}

test('staff can inspect equipment but only administrators can change availability, with CSRF', async () => {
  const id = await machine();
  assert.equal((await get(`/admin/equipment/${id}`, member)).status, 403);
  const view = await get(`/admin/equipment/${id}`, staff);
  assert.equal(view.status, 200); assert.equal(view.body.data.canManage, false);
  assert.equal((await post(`/admin/equipment/${id}/outage`, outage, staff)).status, 403);
  await pool.query(`INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
    SELECT r.roleid,p.permissionid,'equipment','global',true FROM role r JOIN permission p ON p.permissionname='update' WHERE r.role='staff' ON CONFLICT DO NOTHING`);
  assert.equal((await post(`/admin/equipment/${id}/outage`, outage, staff)).body.error.code, 'ADMIN_REQUIRED', 'an explicit equipment grant cannot bypass the administrator requirement');
  assert.equal((await request(app).post(`/api/admin/equipment/${id}/outage`).set('Authorization', 'Bearer ' + administrator.accessToken).send(outage)).status, 403);
  assert.equal((await get(`/admin/equipment/${id}`)).body.data.status, 'available');
});
test('requires a selected reason, physical readiness, valid date and bounded private note', async () => {
  const id = await machine();
  for (const change of [{ reason: '' }, { reason: '__proto__' }, { stopped: false }, { expectedBack: '2027-02-30' }, { expectedBack: '2020-01-01' }, { note: 'x'.repeat(501) }])
    assert.equal((await post(`/admin/equipment/${id}/outage`, { ...outage, ...change })).status, 400);
  assert.equal((await get(`/admin/equipment/${id}`)).body.data.history.length, 0);
});
test('outage and restoration are audited, private, manual, and leave bookings and emails unchanged', async () => {
  const id = await machine(), b = await booking(id);
  assert.equal((await post(`/admin/equipment/${id}/outage`, { ...outage, expectedBack: '2030-01-01' })).status, 200);
  const detail = (await get(`/admin/equipment/${id}`)).body.data;
  assert.equal(detail.availabilityRevision, 2); assert.equal(detail.outage.staffNote, outage.note); assert.ok(detail.outage.startedBy);
  const publicView = (await get('/equipment', member)).body.data.find((m: any) => m.id === id);
  assert.equal(publicView.canReserve, false); assert.equal(publicView.availability.includes('Out of service for repair'), true);
  assert.equal(JSON.stringify(publicView).includes(outage.note), false); assert.equal(JSON.stringify(publicView).includes('startedBy'), false);
  assert.equal((await get(`/admin/equipment/${id}/bookings`)).body.data.items[0].id, b.id);
  assert.equal((await notifications(b.id)).length, 0);
  assert.equal((await post(`/admin/equipment/${id}/restore`, { expectedRevision: 1 })).body.error.code, 'STALE_RECORD');
  assert.equal((await post(`/admin/equipment/${id}/restore`, { expectedRevision: 2, note: 'Bearing replaced' })).status, 200);
  const restored = (await get(`/admin/equipment/${id}`)).body.data;
  assert.equal(restored.status, 'available'); assert.equal(restored.outage, null); assert.ok(restored.history[0].endedAt); assert.equal(restored.history[0].returnNote, 'Bearing replaced');
  assert.equal((await notifications(b.id)).length, 0);
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [b.id])).rows[0].status, 'confirmed');
  const audits = (await pool.query("SELECT action,actor_id,after_state FROM app_staff_audit WHERE entity_type='equipment' AND entity_id=$1 AND source='application' ORDER BY id", [id])).rows;
  assert.equal(audits.length, 2); assert.ok(audits.every(a => a.actor_id === administrator.user.id));
  assert.equal(audits[0].after_state.status, 'maintenance');
});
test('legacy unavailable equipment can be returned to service', async () => {
  const id = await machine('Legacy', 'unavailable');
  assert.equal((await post(`/admin/equipment/${id}/restore`, { expectedRevision: 1 })).status, 200);
});
test('an in-flight grant commits before the outage checks leases; offline grants also block', async () => {
  const id = await machine(), db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SELECT equipmentid FROM equipment WHERE equipmentid=$1 FOR SHARE', [id]);
    await db.query(`INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at)
      VALUES('offline-reader',$1,$2,'equipment',$3,true,'ELIGIBLE',clock_timestamp()+INTERVAL '30 seconds')`, [randomUUID(), member.user.id, id]);
    const takingDown = post(`/admin/equipment/${id}/outage`, outage).then(r => r);
    await db.query('COMMIT');
    const result = await takingDown;
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'EQUIPMENT_IN_USE');
    assert.equal((await get(`/admin/equipment/${id}`)).body.data.activeGrants.length, 1);
    await pool.query("UPDATE app_device_access_event SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE target_id=$1 AND reader_id='offline-reader'", [id]);
    assert.equal((await post(`/admin/equipment/${id}/outage`, outage)).status, 200);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
test('concurrent administrators cannot create duplicate outages', async () => {
  const id = await machine();
  const results = await Promise.all([post(`/admin/equipment/${id}/outage`, outage), post(`/admin/equipment/${id}/outage`, outage)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await get(`/admin/equipment/${id}`)).body.data.history.length, 1);
});
test('unavailable lease state fails closed and rolls back the outage', async () => {
  const id = await machine();
  await pool.query('ALTER TABLE app_device_access_event RENAME TO maintenance_hidden_events');
  try { assert.equal((await post(`/admin/equipment/${id}/outage`, outage)).status, 500); }
  finally { await pool.query('ALTER TABLE maintenance_hidden_events RENAME TO app_device_access_event'); }
  const detail = (await get(`/admin/equipment/${id}`)).body.data;
  assert.equal(detail.status, 'available'); assert.equal(detail.history.length, 0);
});
test('future bookings page includes later days, with an explicit next page', async () => {
  const id = await machine();
  for (let n = 1; n <= 51; n++) await booking(id, n);
  const first = (await get(`/admin/equipment/${id}/bookings`)).body.data;
  assert.equal(first.items.length, 50); assert.equal(first.nextOffset, 50);
  const second = (await get(`/admin/equipment/${id}/bookings?offset=50`)).body.data;
  assert.equal(second.items.length, 1); assert.equal(second.nextOffset, null);
});
test('move preview is read-only; confirmation rechecks the rate, slot and revision', async () => {
  const source = await machine(), target = await machine(), b = await booking(source);
  const base = `/admin/equipment/${source}/bookings/${b.id}`;
  const input = { expectedRevision: b.revision, equipmentId: target };
  const review = await post(base + '/review-move', input);
  assert.equal(review.status, 200, JSON.stringify(review.body)); assert.equal(review.body.data.rate, 12);
  assert.equal((await notifications(b.id)).length, 0);
  assert.equal((await pool.query('SELECT equipmentid FROM reservation WHERE reservationid=$1', [b.id])).rows[0].equipmentid, source);
  await pool.query('UPDATE equipment SET hourlyrate=20 WHERE equipmentid=$1', [target]);
  assert.equal((await post(base + '/move', { ...input, expectedRate: 12 })).body.error.code, 'RATE_CHANGED');
  const conflict = await booking(target);
  assert.equal((await post(base + '/move', { ...input, expectedRate: 20 })).body.error.code, 'RESERVATION_CONFLICT');
  await pool.query("UPDATE reservation SET status='cancelled' WHERE reservationid=$1", [conflict.id]);
  const moved = await post(base + '/move', { ...input, expectedRate: 20 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body)); assert.equal(moved.body.data.equipmentId, target);
  assert.equal((await notifications(b.id)).length, 1);
  assert.equal((await post(base + '/cancel', { expectedRevision: b.revision })).body.error.code, 'STALE_RECORD');
  assert.equal((await notifications(b.id)).length, 1);
  const cancel = await post(`/admin/equipment/${target}/bookings/${b.id}/cancel`, { expectedRevision: moved.body.data.revision });
  assert.equal(cancel.status, 200); assert.equal((await notifications(b.id)).length, 2);
});
test('review rejects target certification and machine-wide cooldown failures', async () => {
  const source = await machine(), target = await machine(), b = await booking(source);
  const cert = (await pool.query("INSERT INTO certifications(certid,name) VALUES(880001,'Maintenance target certification') RETURNING certid")).rows[0].certid;
  await pool.query('UPDATE equipment SET certid=$2 WHERE equipmentid=$1', [target, cert]);
  const path = `/admin/equipment/${source}/bookings/${b.id}/review-move`, input = { expectedRevision: b.revision, equipmentId: target };
  assert.equal((await post(path, input)).body.error.code, 'CERTIFICATION_REQUIRED');
  await pool.query('UPDATE equipment SET certid=NULL WHERE equipmentid=$1', [target]);
  await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    SELECT $2,$3,'Test',endtime+INTERVAL '5 minutes',endtime+INTERVAL '65 minutes','confirmed' FROM reservation WHERE reservationid=$1`, [b.id, staff.user.id, target]);
  assert.equal((await post(path, input)).body.error.code, 'RESERVATION_COOLDOWN');
  assert.equal((await notifications(b.id)).length, 0);
});
test('move confirmation rechecks the member waiver and target availability, and cancel respects booking permissions', async () => {
  const source = await machine(), target = await machine(), b = await booking(source);
  await pool.query('UPDATE equipment SET waiverrequired=true WHERE equipmentid=$1', [target]);
  const base = `/admin/equipment/${source}/bookings/${b.id}`, input = { equipmentId: target, expectedRevision: b.revision };
  assert.equal((await post(base + '/review-move', input)).status, 200);
  await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1', [member.user.id]);
  try { assert.equal((await post(base + '/move', { ...input, expectedRate: 12 })).status, 403); }
  finally { await pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1', [member.user.id]); }
  await post(`/admin/equipment/${target}/outage`, outage);
  assert.equal((await post(base + '/move', { ...input, expectedRate: 12 })).body.error.code, 'EQUIPMENT_UNAVAILABLE');
  await pool.query(`UPDATE role_permission SET isallowed=false WHERE roleid=(SELECT roleid FROM role WHERE role='staff') AND permissionid=3 AND resourcename='reservation' AND scopetype='global'`);
  try { assert.equal((await post(base + '/cancel', { expectedRevision: b.revision }, staff)).status, 403); }
  finally { await pool.query(`UPDATE role_permission SET isallowed=true WHERE roleid=(SELECT roleid FROM role WHERE role='staff') AND permissionid=3 AND resourcename='reservation' AND scopetype='global'`); }
  assert.equal((await notifications(b.id)).length, 0);
});
test('outage blocks new member reservations and signed reader decisions', async () => {
  await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Test',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC','confirmed')`, [member.user.id, readerMachine]);
  assert.equal((await post(`/admin/equipment/${readerMachine}/outage`, outage)).status, 200);
  const denied = await scan(); assert.equal(denied.body.data.reason, 'RESOURCE_UNAVAILABLE');
  assert.equal((await post('/reservations', { equipmentId: readerMachine, startTime: new Date(Date.now() + 86400000).toISOString(), endTime: new Date(Date.now() + 90000000).toISOString() }, member)).body.error.code, 'EQUIPMENT_UNAVAILABLE');
});
test('reader initialization shares the deadline and cannot produce a late check-in', async () => {
  await post(`/admin/equipment/${readerMachine}/restore`, { expectedRevision: 2 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const registry = new ReaderRegistry(pool, devices), ready = registry.ready.bind(registry);
  let finished!: () => void;
  const prepared = new Promise<void>(resolve => { finished = resolve; });
  registry.ready = async () => { await gate; await ready(); finished(); };
  const slow = express(); slow.post('/api/devices/decision', express.raw({ type: 'application/json' }), deviceDecision(pool, tz, devices, registry));
  const before = (await pool.query('SELECT count(*)::int AS n FROM check_in')).rows[0].n;
  const started = performance.now(), response = await scan(slow);
  assert.equal(response.body.data.reason, 'VERIFICATION_TIMEOUT'); assert.ok(performance.now() - started < 2250);
  release(); await prepared; await new Promise(resolve => setImmediate(resolve));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM check_in')).rows[0].n, before);
  assert.equal((await scan()).body.data.allowed, true, 'fixture is eligible once initialization is ready');
});
