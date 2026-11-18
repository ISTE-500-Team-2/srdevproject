// FR-048 training notices and NFR-003 studio booking alerts: what is queued, for whom, and how often.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before, beforeEach, after, test, mock} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {createApp} from '../../src/app.js';
import {StudioStripe} from '../../src/studios/stripe.js';
import {EquipmentBilling} from '../../src/billing/equipment.js';
import {ReservationService} from '../../src/services/ReservationService.js';
import {businessToday} from '../../src/businessDate.js';
import {enqueueNotification} from '../../src/notifications/store.js';
import {renderNotification} from '../../src/notifications/templates.js';

const database = 'arbor_training_notices_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({database});
const zone = 'America/New_York';
const provider = new StudioStripe({key: 'sk_test_notices_fake', webhookSecret: 'whsec_notices_fake', origin: 'http://localhost:8080'});
const service = new ReservationService(pool, zone, provider);
const billing = new EquipmentBilling(pool, provider, zone);
const app = createApp(pool, {port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: zone, jwtKey: randomBytes(32), studioStripe: provider.config});
type Session = {accessToken: string; csrfToken: string; user: {id: number}};
// Staff accounts name the account each request is for, as the site does.
const signed = (who: Session, call: request.Test) =>
  call.set('Authorization', 'Bearer ' + who.accessToken).set('X-CSRF-Token', who.csrfToken).set('X-Account-Subject', String(who.user.id));
const as = (who: Session) => ({
  get: (path: string) => signed(who, request(app).get('/api' + path)),
  post: (path: string, body: object = {}) => signed(who, request(app).post('/api' + path)).send(body),
  patch: (path: string, body: object = {}) => signed(who, request(app).patch('/api' + path)).send(body),
});
let created = false, member: Session, admin: Session, equipment: number, cert: number, counter = 0;
const booking = (extra = {}) => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2 + counter++);
  start.setUTCHours(15, 0, 0, 0);
  return {equipmentId: equipment, startTime: start.toISOString(), endTime: new Date(+start + 3600000).toISOString(),
    requestKey: randomUUID(), amountCents: 2800};
};
const notices = async (kind: string, userId = member.user.id) => (await pool.query(
  'SELECT dedupe_key AS "dedupeKey",status,payload FROM app_notification_outbox WHERE kind=$1 AND userid=$2 ORDER BY id', [kind, userId])).rows;
const optOut = (userId: number, enabled: boolean) => pool.query(`INSERT INTO app_notification_preferences(userid,enabled) VALUES($1,$2)
  ON CONFLICT(userid) DO UPDATE SET enabled=EXCLUDED.enabled`, [userId, enabled]);
const context = {recipientEmail: 'member@example.test', senderName: 'Studio', senderEmail: 'studio@example.test', postalAddress: '1 Mill Rd',
  preferencesUrl: 'https://studio.example.test/profile'};

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await request(app).post('/api/auth/demo').send({role: 'member'})).body.data;
  admin = (await request(app).post('/api/auth/demo').send({role: 'admin'})).body.data;
  await pool.query("UPDATE user_membership SET end_date='2031-01-01',status='active' WHERE userid IN ($1,$2)", [member.user.id, admin.user.id]);
  cert = (await pool.query("INSERT INTO certifications(certid,name) VALUES(88001,'Laser safety') RETURNING certid")).rows[0].certid;
  equipment = (await pool.query(`INSERT INTO equipment(name,category,status,hourlyrate,waiverrequired,location,certid)
    VALUES('Notice Laser','Laser cutter','available',28,false,'Makerspace',$1) RETURNING equipmentid`, [cert])).rows[0].equipmentid;
  const sessions = new Map<string, any>();
  const prototype = Object.getPrototypeOf(provider.sdk.checkout.sessions);
  mock.method(prototype, 'create', async (params: any) => {
    const id = 'cs_notice_' + params.client_reference_id;
    if (!sessions.has(id)) sessions.set(id, {id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid',
      client_reference_id: params.client_reference_id, metadata: params.metadata, amount_total: 2800,
      currency: 'usd', url: 'https://checkout.stripe.com/' + id});
    return sessions.get(id);
  });
  mock.method(prototype, 'retrieve', async (id: string) => sessions.get(id));
});
beforeEach(async () => {
  await pool.query('DELETE FROM app_notification_outbox');
  await pool.query('DELETE FROM user_certifications WHERE certid=$1', [cert]);
  await pool.query('DELETE FROM app_notification_preferences');
});
after(async () => {
  mock.restoreAll();
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('a member refused for missing training gets one training notice a day, naming the equipment and certification', async () => {
  await assert.rejects(service.create(member.user.id, booking()), {code: 'CERTIFICATION_REQUIRED'});
  const http = await as(member).post('/reservations', booking());
  assert.equal(http.status, 403, http.text);
  assert.equal(http.body.error.code, 'CERTIFICATION_REQUIRED');
  await assert.rejects(service.create(member.user.id, booking()), {code: 'CERTIFICATION_REQUIRED'});
  const rows = await notices('certification_required');
  assert.equal(rows.length, 1, 'repeated attempts the same day queue one notice');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].dedupeKey, `certification-required:${member.user.id}:${cert}:${businessToday(zone)}`);
  assert.equal(rows[0].payload.equipmentName, 'Notice Laser');
  assert.equal(rows[0].payload.certificationName, 'Laser safety');
  const email = renderNotification('certification_required', rows[0].payload, context);
  assert.match(email.textContent, /Notice Laser/);
  assert.match(email.textContent, /Laser safety/);
  assert.match(email.htmlContent, /https:\/\/studio\.example\.test\/classes/, 'the email links to the class catalogue members can register from');
  assert.equal((await pool.query('SELECT 1 FROM reservation WHERE equipmentid=$1', [equipment])).rowCount, 0, 'the booking is still refused');
});

test('an expired certification counts as missing training', async () => {
  await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status) VALUES(88001,$1,$2,now()-interval '1 day','active')`,
    [member.user.id, cert]);
  await assert.rejects(service.create(member.user.id, booking()), {code: 'CERTIFICATION_REQUIRED'});
  assert.equal((await notices('certification_required')).length, 1);
});

test('staff refused while booking for a member do not mail the member', async () => {
  await assert.rejects(service.create(admin.user.id, {...booking(), userId: member.user.id}), {code: 'CERTIFICATION_REQUIRED'});
  assert.equal((await notices('certification_required')).length, 0);
  assert.equal((await notices('certification_required', admin.user.id)).length, 0);
});

test('a member who turned off email gets no training notice', async () => {
  await optOut(member.user.id, false);
  await assert.rejects(service.create(member.user.id, booking()), {code: 'CERTIFICATION_REQUIRED'});
  assert.deepEqual((await notices('certification_required')).map(r => r.status), ['suppressed']);
});

test('a notice that cannot be queued leaves the refusal unchanged', async () => {
  const logged = mock.method(console, 'error', () => {});
  await pool.query('ALTER TABLE app_notification_outbox RENAME TO app_notification_outbox_away');
  try {
    await assert.rejects(service.create(member.user.id, booking()), {code: 'CERTIFICATION_REQUIRED'});
  } finally {
    await pool.query('ALTER TABLE app_notification_outbox_away RENAME TO app_notification_outbox');
    logged.mock.restore();
  }
  assert.equal(logged.mock.calls[0]?.arguments[0], 'Training notice not queued');
});

test('a member resuming payment after their training lapsed is refused and told how to retrain', async () => {
  await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status) VALUES(88001,$1,$2,now()+interval '1 year','active')`,
    [member.user.id, cert]);
  const hold = await service.create(member.user.id, booking()) as {id: number; status: string};
  assert.equal(hold.status, 'pending');
  await pool.query("UPDATE user_certifications SET status='revoked' WHERE certid=$1", [cert]);
  await assert.rejects(billing.checkout(member.user.id, hold.id), {code: 'CERTIFICATION_REQUIRED'});
  assert.equal((await notices('certification_required')).length, 1);
});

test('a revoked certification emails the member once, without the staff reason', async () => {
  await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status) VALUES(88001,$1,$2,now()+interval '1 year','active')`,
    [member.user.id, cert]);
  const revoke = async () => {
    const {revision} = (await pool.query('SELECT revision FROM user_certifications WHERE certid=$1', [cert])).rows[0];
    const response = await as(admin).post(`/training/users/${member.user.id}/certifications/${cert}/revoke`,
      {expectedRevision: revision, reason: 'Private incident note'});
    assert.equal(response.status, 200, response.text);
  };
  await revoke();
  await revoke();
  const rows = await notices('certification_revoked');
  assert.equal(rows.length, 1, 'revoking an already revoked record sends nothing more');
  assert.deepEqual(rows[0].payload, {certificationName: 'Laser safety'});
  const email = renderNotification('certification_revoked', rows[0].payload, context);
  assert.match(email.textContent, /Laser safety/);
  assert.match(email.textContent, /contact the studio/);
  assert.doesNotMatch(email.textContent + email.htmlContent, /Private incident note/);
});

test('migration 060 adds studio booking alerts, on for every existing account', async () => {
  const sql = await readFile(new URL('../../../database/migrations/060_staff_studio_booking_alerts.sql', import.meta.url), 'utf8');
  await pool.query('BEGIN');
  try {
    await pool.query('ALTER TABLE app_notification_preferences DROP COLUMN studio_booking_alerts');
    await pool.query(`INSERT INTO app_notification_preferences(userid,enabled) VALUES($1,false)`, [admin.user.id]);
    await pool.query(sql);
    assert.deepEqual((await pool.query('SELECT enabled,studio_booking_alerts FROM app_notification_preferences WHERE userid=$1', [admin.user.id])).rows,
      [{enabled: false, studio_booking_alerts: true}]);
  } finally {await pool.query('ROLLBACK');}
});

test('only staff accounts see studio booking alerts, and turning them off keeps every other email', async () => {
  assert.equal((await as(member).get('/me/notifications')).body.data.studioBookingAlerts, undefined);
  assert.deepEqual((await as(admin).get('/me/notifications')).body.data, {enabled: true, timeZone: zone, studioBookingAlerts: true});
  // A member's request can't set it.
  assert.equal((await as(member).patch('/me/notifications', {enabled: true, timeZone: zone, studioBookingAlerts: false})).body.data.studioBookingAlerts, undefined);
  assert.equal((await as(admin).patch('/me/notifications', {enabled: true, timeZone: zone, studioBookingAlerts: 'no'})).status, 400);

  for (const kind of ['admin_studio_reservation_confirmed', 'payment_receipt'] as const)
    await enqueueNotification(pool, {userId: admin.user.id, kind, dedupeKey: `pending-${kind}`, payload: {}});
  const off = await as(admin).patch('/me/notifications', {enabled: true, timeZone: zone, studioBookingAlerts: false});
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body.data, {enabled: true, timeZone: zone, studioBookingAlerts: false});
  assert.deepEqual((await notices('admin_studio_reservation_confirmed', admin.user.id)).map(r => r.status), ['suppressed']);
  assert.deepEqual((await notices('payment_receipt', admin.user.id)).map(r => r.status), ['pending']);
  // A save that leaves it out (an older page) keeps the choice.
  const kept = await as(admin).patch('/me/notifications', {enabled: true, timeZone: 'America/Chicago'});
  assert.equal(kept.body.data.studioBookingAlerts, false);
});
