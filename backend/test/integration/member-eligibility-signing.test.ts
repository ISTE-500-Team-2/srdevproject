import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { Pool } from 'pg';
import type Stripe from 'stripe';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { EquipmentBilling } from '../../src/billing/equipment.js';
import { startEquipmentReconciliation } from '../../src/equipmentReconciliation.js';
import { ReservationModel } from '../../src/models/ReservationModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_eligibility_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const stripeConfig = { key: 'sk_test_eligibility_fake', webhookSecret: 'whsec_eligibility_fake', origin: 'http://localhost:8080' };
// Every StudioStripe instance (including the app's own) shares these mocked session methods.
const sessionsApi = Object.getPrototypeOf(new StudioStripe(stripeConfig).sdk.checkout.sessions);
const sessions = new Map<string, any>();
let app: ReturnType<typeof createApp>, member: any, created = false, machine: number, waiverMachine: number, counter = 0;
const get = (path: string) => request(app).get('/api' + path).set('Authorization', 'Bearer ' + member.accessToken);
const post = (path: string, body: object) => request(app).post('/api' + path)
  .set('Authorization', 'Bearer ' + member.accessToken).set('X-CSRF-Token', member.csrfToken).send(body);

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true, allowedOrigins: [],
    timeZone: 'America/New_York', jwtKey: randomBytes(32), studioStripe: stripeConfig });
  member = (await request(app).post('/api/auth/demo').send({ role: 'member' })).body.data;
  await pool.query("UPDATE user_membership SET startdate=now()-interval '1 day',end_date='2031-01-01',status='active' WHERE userid=$1", [member.user.id]);
  machine = (await pool.query("INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location) VALUES('Eligibility test machine','available',7,false,'Makerspace') RETURNING equipmentid")).rows[0].equipmentid;
  waiverMachine = (await pool.query("INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location) VALUES('Eligibility waiver machine','available',7,true,'Makerspace') RETURNING equipmentid")).rows[0].equipmentid;
  mock.method(sessionsApi, 'create', async (params: Stripe.Checkout.SessionCreateParams) => {
    const id = 'cs_eligibility_' + params.client_reference_id;
    if (!sessions.has(id)) sessions.set(id, { id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid',
      client_reference_id: params.client_reference_id, metadata: params.metadata, currency: 'usd', url: 'https://checkout.stripe.com/' + id,
      amount_total: Number(params.line_items![0]!.quantity) * Number(params.line_items![0]!.price_data!.unit_amount) });
    return sessions.get(id);
  });
  mock.method(sessionsApi, 'retrieve', async (id: string) => sessions.get(id));
});
after(async () => {
  mock.restoreAll();
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

test('overview and catalogue report a reason code beside each reason, with unchanged wording', async () => {
  const overview = (await get('/me/overview')).body.data;
  assert.deepEqual(overview.reasons, ['Required policies and waivers need your signature']);
  assert.deepEqual(overview.reasonCodes, ['WAIVER_REQUIRED']);
  assert.equal(overview.canCheckIn, false);
  const catalogue = (await get('/equipment')).body.data;
  const plain = catalogue.find((item: any) => item.id === machine), guarded = catalogue.find((item: any) => item.id === waiverMachine);
  assert.deepEqual([plain.canReserve, plain.reasonCodes, plain.availability], [true, [], 'Choose a time to check availability']);
  assert.deepEqual([guarded.canReserve, guarded.reasonCodes, guarded.availability], [false, ['WAIVER_REQUIRED'], 'Signed waivers required']);
  await pool.query("UPDATE equipment SET status='maintenance' WHERE equipmentid=$1", [machine]);
  try {
    const down = (await get('/equipment')).body.data.find((item: any) => item.id === machine);
    assert.deepEqual([down.reasonCodes, down.availability], [['RESOURCE_UNAVAILABLE'], 'Equipment unavailable']);
  } finally { await pool.query("UPDATE equipment SET status='available' WHERE equipmentid=$1", [machine]); }
  for (const waiver of (await get('/me/waivers')).body.data)
    assert.equal(waiver.formLines.length, waiver.description.split(/\r?\n/).length, waiver.name);
});

test('signing rechecks applicability under the waiver lock, so a version retired meanwhile is refused', async () => {
  const waiver = (await get('/me/waivers')).body.data.find((w: any) => !w.signed);
  const publisher = await pool.connect();
  try {
    await publisher.query('BEGIN');
    await publisher.query('SELECT waiverid FROM waiver WHERE waiverid=$1 FOR UPDATE', [waiver.id]);
    await publisher.query('UPDATE waiver SET isactive=false WHERE waiverid=$1', [waiver.id]);
    let settled = false;
    const signing = post(`/me/waivers/${waiver.id}/sign`, waiverAcceptance(waiver)).then(response => { settled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled, false, 'signing waits for the version lock');
    await publisher.query('COMMIT');
    const response = await signing;
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'NOT_FOUND');
  } finally {
    await publisher.query('ROLLBACK').catch(() => {});
    publisher.release();
  }
  assert.equal((await pool.query('SELECT 1 FROM user_waiver WHERE userid=$1 AND waiverid=$2', [member.user.id, waiver.id])).rowCount, 0);
  await pool.query('UPDATE waiver SET isactive=true WHERE waiverid=$1', [waiver.id]);
  const signed = await post(`/me/waivers/${waiver.id}/sign`, waiverAcceptance(waiver));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.data.find((w: any) => w.id === waiver.id).signed, true);
});

test('a building check failure is reported with its access code', async () => {
  for (const waiver of (await get('/me/waivers')).body.data.filter((w: any) => !w.signed))
    assert.equal((await post(`/me/waivers/${waiver.id}/sign`, waiverAcceptance(waiver))).status, 200);
  const building = (await pool.query("INSERT INTO building(name) VALUES('Second eligibility building') RETURNING buildingid")).rows[0].buildingid;
  try {
    const overview = (await get('/me/overview')).body.data;
    assert.deepEqual(overview.reasons, ['Choose the building where you are arriving.']);
    assert.deepEqual(overview.reasonCodes, ['BUILDING_REQUIRED']);
  } finally { await pool.query('DELETE FROM building WHERE buildingid=$1', [building]); }
  const overview = (await get('/me/overview')).body.data;
  assert.deepEqual([overview.canCheckIn, overview.reasons, overview.reasonCodes], [true, [], []]);
  const guarded = (await get('/equipment')).body.data.find((item: any) => item.id === waiverMachine);
  assert.deepEqual([guarded.canReserve, guarded.reasonCodes], [true, []]);
});

test('catalogue reads no longer reconcile payments; the background job releases expired holds and returns still confirm', async () => {
  const service = new ReservationService(pool, 'America/New_York', new StudioStripe(stripeConfig));
  const hold = async () => {
    const startTime = new Date(Date.UTC(2030, 0, 2, 15) + counter++ * 86_400_000).toISOString();
    const result: any = await service.create(member.user.id, { equipmentId: machine, startTime, requestKey: randomUUID(), amountCents: 700,
      endTime: new Date(new Date(startTime).getTime() + 3_600_000).toISOString() });
    assert.equal(result.status, 'pending');
    return { id: result.id as number, startTime };
  };
  const state = async (id: number) => (await new ReservationModel(pool).find(id))!.status;
  const occupied = async () => (await get('/equipment')).body.data.find((item: any) => item.id === machine).occupied
    .map((slot: any) => new Date(slot.startTime).toISOString());

  const expired = await hold();
  const checkout = (await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [expired.id])).rows[0].checkout_id;
  Object.assign(sessions.get(checkout), { status: 'expired' });
  await pool.query("UPDATE app_equipment_checkout SET hold_until=now()-interval '1 second' WHERE reservation_id=$1", [expired.id]);
  assert.ok((await occupied()).includes(expired.startTime));
  assert.equal(await state(expired.id), 'pending', 'a catalogue read leaves payment state alone');

  const runtime = startEquipmentReconciliation(new EquipmentBilling(pool, new StudioStripe(stripeConfig), 'America/New_York'), 10);
  try {
    for (let i = 0; i < 100 && await state(expired.id) !== 'cancelled'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  } finally { await runtime.stop(); }
  assert.equal(await state(expired.id), 'cancelled');
  assert.equal((await occupied()).includes(expired.startTime), false);

  // Returning from Stripe lists reservations, which reconciles the member's own checkout.
  const paid = await hold();
  const session = sessions.get((await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [paid.id])).rows[0].checkout_id);
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + session.id });
  const listed = await get('/reservations');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.find((r: any) => r.id === paid.id).status, 'confirmed');
});
