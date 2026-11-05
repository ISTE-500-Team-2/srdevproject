import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {before, beforeEach, after, test, mock} from 'node:test';
import {Pool} from 'pg';
import {once} from 'node:events';
import type {Server} from 'node:http';
import request from 'supertest';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {createApp} from '../../src/app.js';
import {StudioStripe} from '../../src/studios/stripe.js';
import {EquipmentBilling} from '../../src/billing/equipment.js';
import {ReservationService} from '../../src/services/ReservationService.js';
import {equipmentWaiverName, waiverAcceptance} from '../helpers/waiver.js';

const database = 'arbor_equipment_waivers_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({database});
const provider = new StudioStripe({key: 'sk_test_waivers_fake', webhookSecret: 'whsec_waivers_fake', origin: 'http://localhost:8080'});
const service = new ReservationService(pool, 'America/New_York', provider);
const billing = new EquipmentBilling(pool, provider);
const sessions = new Map<string, any>();
let member: number, admin: number, equipment: number, counter = 0, creates = 0, created = false;
let server: Server;
let memberAgent: ReturnType<typeof request.agent>, adminAgent: ReturnType<typeof request.agent>;
const booking = (extra = {}) => {
  const start = new Date(Date.UTC(2030, 1, 1 + counter++, 15));
  return {equipmentId: equipment, startTime: start.toISOString(), endTime: new Date(+start + 3600000).toISOString(),
    requestKey: randomUUID(), amountCents: 2800, ...extra};
};
async function sign(agent: typeof memberAgent, includeEquipment = true) {
  const response = await agent.get('/api/me/waivers');
  assert.equal(response.status, 200, response.text);
  const policies = response.body.data;
  for (const policy of policies) {
    if (policy.signed || !includeEquipment && policy.name === equipmentWaiverName) continue;
    const response = await agent.post(`/api/me/waivers/${policy.id}/sign`).send(waiverAcceptance(policy));
    assert.equal(response.status, 200, response.text);
  }
}
async function signatureState(approval: boolean) {
  await pool.query(`UPDATE user_waiver SET approval=$2,expires_at=NULL WHERE userid=$1 AND
    (NOT $2 OR userwaiverid IN (SELECT DISTINCT ON (waiverid) userwaiverid FROM user_waiver WHERE userid=$1 ORDER BY waiverid,userwaiverid DESC))`, [member, approval]);
}
async function currentSession(id: number) {
  const row = (await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [id])).rows[0];
  return sessions.get(row.checkout_id);
}
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  const app = createApp(pool, {port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32), studioStripe: provider.config});
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  memberAgent = request.agent(server); adminAgent = request.agent(server);
  for (const [agent, role] of [[memberAgent, 'member'], [adminAgent, 'admin']] as const) {
    const response = await agent.post('/api/auth/demo').send({role});
    assert.equal(response.status, 200, response.text);
    agent.set('Authorization', 'Bearer ' + response.body.data.accessToken).set('X-CSRF-Token', response.body.data.csrfToken);
    if (role === 'member') member = response.body.data.user.id; else admin = response.body.data.user.id;
  }
  await pool.query("UPDATE user_membership SET end_date='2031-01-01',status='active' WHERE userid IN ($1,$2)", [member, admin]);
  equipment = (await pool.query("INSERT INTO equipment(name,category,status,hourlyrate,waiverrequired,location) VALUES('Waiver CNC','Large CNC','available',28,true,'Makerspace') RETURNING equipmentid")).rows[0].equipmentid;
  const prototype = Object.getPrototypeOf(provider.sdk.checkout.sessions);
  mock.method(prototype, 'create', async (params: any) => {
    creates++;
    const id = 'cs_waiver_' + params.client_reference_id;
    if (!sessions.has(id)) sessions.set(id, {id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid',
      client_reference_id: params.client_reference_id, metadata: params.metadata, amount_total: 2800,
      currency: 'usd', url: 'https://checkout.stripe.com/' + id});
    return sessions.get(id);
  });
  mock.method(prototype, 'retrieve', async (id: string) => sessions.get(id));
});
beforeEach(async () => {
  await pool.query('UPDATE user_waiver SET approval=false,expires_at=NULL WHERE userid IN ($1,$2)', [member, admin]);
  await pool.query('UPDATE equipment SET certid=NULL WHERE equipmentid=$1', [equipment]);
});
after(async () => {
  mock.restoreAll();
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('unsigned CNC waivers block member and staff-assisted HTTP booking before any Stripe session is created', async () => {
  const count = creates;
  const catalog = await memberAgent.get('/api/equipment');
  const cnc = catalog.body.data.find((item: any) => item.id === equipment);
  assert.equal(cnc.canReserve, false); assert.match(cnc.availability, /Signed waivers required/);
  const own = await memberAgent.post('/api/reservations').send(booking());
  assert.equal(own.status, 403, own.text); assert.equal(own.body.error.code, 'WAIVER_REQUIRED');
  await sign(adminAgent);
  const assisted = await adminAgent.post('/api/reservations').send(booking({userId: member}));
  assert.equal(assisted.status, 403, assisted.text); assert.equal(assisted.body.error.code, 'WAIVER_REQUIRED');
  assert.equal(creates, count);
  assert.equal((await pool.query('SELECT 1 FROM reservation WHERE equipmentid=$1', [equipment])).rowCount, 0);
});

test('signing general policies alone is insufficient; the current specialized equipment waiver unlocks checkout', async () => {
  await sign(memberAgent, false);
  await assert.rejects(service.create(member, booking()), {code: 'WAIVER_REQUIRED'});
  await sign(memberAgent);
  const result = await service.create(member, booking());
  assert.equal(result.status, 'pending'); assert.ok('checkoutUrl' in result && result.checkoutUrl);
});

test('expired, unapproved and superseded equipment waiver signatures do not permit checkout', async () => {
  await sign(memberAgent);
  await pool.query("UPDATE user_waiver SET expires_at=now()-interval '1 second' WHERE userid=$1", [member]);
  await assert.rejects(service.create(member, booking()), {code: 'WAIVER_REQUIRED'});
  await signatureState(false);
  await assert.rejects(service.create(member, booking()), {code: 'WAIVER_REQUIRED'});
  await signatureState(true);
  await pool.query(`INSERT INTO waiver(name,version,description,effectivedate,isactive,required,policy_scope)
    VALUES($1,'waiver-regression-v2','Updated fixture safety waiver',NOW() AT TIME ZONE 'UTC',true,true,'equipment')`, [equipmentWaiverName]);
  await assert.rejects(service.create(member, booking()), {code: 'WAIVER_REQUIRED'});
  await sign(memberAgent);
  assert.equal((await service.create(member, booking())).status, 'pending');
});

test('a waiver expiring before the reserved session ends cannot satisfy the reservation', async () => {
  await sign(memberAgent);
  await pool.query("UPDATE user_waiver SET expires_at=now()+interval '1 day' WHERE userid=$1", [member]);
  await assert.rejects(service.create(member, booking()), {code: 'WAIVER_REQUIRED'});
});

test('resuming Checkout and retrying the original reservation recheck waivers rather than bypassing eligibility', async () => {
  await sign(memberAgent);
  const body = booking(), pending = await service.create(member, body), count = creates;
  await signatureState(false);
  const resume = await memberAgent.post(`/api/reservations/${pending.id}/checkout`).send({});
  assert.equal(resume.status, 403, resume.text); assert.equal(resume.body.error.code, 'WAIVER_REQUIRED');
  await assert.rejects(service.create(member, body), {code: 'WAIVER_REQUIRED'});
  assert.equal(creates, count);
});

test('payment cannot confirm a booking with revoked waivers; signing again allows the existing paid session to reconcile once', async () => {
  await sign(memberAgent);
  const pending = await service.create(member, booking()), session = await currentSession(pending.id);
  Object.assign(session, {status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + session.id});
  await signatureState(false);
  await assert.rejects(billing.apply(session), {code: 'WAIVER_REQUIRED'});
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [pending.id])).rows[0].status, 'pending');
  assert.equal((await pool.query('SELECT 1 FROM payment WHERE reference=$1', [session.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM app_notification_outbox WHERE dedupe_key=$1', [`equipment-confirmed:${pending.id}`])).rowCount, 0);
  await sign(memberAgent); await billing.apply(session); await billing.apply(session);
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [pending.id])).rows[0].status, 'confirmed');
  assert.equal((await pool.query('SELECT 1 FROM payment WHERE reference=$1', [session.id])).rowCount, 1);
});

test('staff checkout uses the booked member’s waivers, including on resume', async () => {
  await sign(memberAgent);
  const pending = await service.create(admin, booking({userId: member}));
  assert.equal(pending.status, 'pending');
  await sign(adminAgent); await signatureState(false);
  await assert.rejects(billing.checkout(admin, pending.id), {code: 'WAIVER_REQUIRED'});
});

test('signed waivers do not replace required machine certification', async () => {
  await sign(memberAgent);
  const cert = (await pool.query("INSERT INTO certifications(certid,name) VALUES(87003,'CNC safety test') RETURNING certid")).rows[0].certid;
  await pool.query('UPDATE equipment SET certid=$2 WHERE equipmentid=$1', [equipment, cert]);
  await assert.rejects(service.create(member, booking()), {code: 'CERTIFICATION_REQUIRED'});
  await pool.query("INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate) VALUES(87003,$1,$2,'active','2031-01-01')", [member, cert]);
  assert.equal((await service.create(member, booking())).status, 'pending');
});
