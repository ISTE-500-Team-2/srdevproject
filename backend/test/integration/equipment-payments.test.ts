import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { before, after, test, mock } from 'node:test';
import { Pool } from 'pg';
import Stripe from 'stripe';
import request from 'supertest';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { ReservationModel } from '../../src/models/ReservationModel.js';
import { EquipmentBilling } from '../../src/billing/equipment.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { createApp } from '../../src/app.js';

const database = 'arbor_equipment_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({database});
const provider = new StudioStripe({key: 'sk_test_equipment_fake', webhookSecret: 'whsec_equipment_fake', origin: 'http://localhost:8080'});
const billing = new EquipmentBilling(pool, provider);
const service = new ReservationService(pool, 'America/New_York', provider);
const sessions = new Map<string, any>();
let member: number, equipment: number, created = false, counter = 0;
const quotes: Stripe.Checkout.SessionCreateParams[] = [];
const checkoutKeys: (string | undefined)[] = [];
const start = Date.UTC(2030, 0, 2, 15);
const input = (hours = 1, extra = {}) => ({equipmentId: equipment, startTime: new Date(start + counter++ * 86400000).toISOString(),
  endTime: '', requestKey: randomUUID(), amountCents: hours * 700, ...extra});
function booking(hours = 1, extra = {}) {
  const data = input(hours, extra);
  return {...data, endTime: new Date(new Date(data.startTime).getTime() + hours * 3600000).toISOString()};
}
const sessionFor = async (id: number) => sessions.get((await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [id])).rows[0].checkout_id);
const state = async (id: number) => (await new ReservationModel(pool).find(id))!;
const paid = (s: any) => Object.assign(s, {status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + s.id});
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  const app = createApp(pool, {port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32)});
  const login = await request(app).post('/api/auth/demo').send({role: 'member'});
  assert.equal(login.status, 200, login.text);
  member = login.body.data.user.id;
  await pool.query("UPDATE user_membership SET startdate=now()-interval '1 day',end_date='2031-01-01',status='active' WHERE userid=$1", [member]);
  equipment = (await pool.query("INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location) VALUES('Payment test machine','available',7,false,'Makerspace') RETURNING equipmentid")).rows[0].equipmentid;
  mock.method(provider.sdk.checkout.sessions, 'create', async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
    quotes.push(params);
    checkoutKeys.push(options?.idempotencyKey);
    const id = 'cs_equipment_' + params.client_reference_id;
    if (!sessions.has(id)) sessions.set(id, {id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid',
      client_reference_id: params.client_reference_id, metadata: params.metadata, amount_total: Number(params.line_items![0]!.quantity) * Number(params.line_items![0]!.price_data!.unit_amount),
      currency: 'usd', url: 'https://checkout.stripe.com/' + id});
    return sessions.get(id);
  });
  mock.method(provider.sdk.checkout.sessions, 'retrieve', async (id: string) => sessions.get(id));
  mock.method(provider.sdk.checkout.sessions, 'expire', async (id: string) => Object.assign(sessions.get(id), {status: 'expired'}));
});
after(async () => {
  mock.restoreAll();
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

test('server charges $7 for one hour and $14 for two; unpaid holds send no confirmation', async () => {
  for (const hours of [1, 2]) {
    const result = await service.create(member, booking(hours));
    assert.equal(result.status, 'pending');
    assert.match((result as any).checkoutUrl, /^https:\/\/checkout.stripe.com\//);
    assert.equal((result as any).amountCents, hours * 700);
    assert.equal(quotes.at(-1)!.line_items![0]!.price_data!.unit_amount, 700);
    assert.equal(quotes.at(-1)!.line_items![0]!.quantity, hours);
    assert.equal((await pool.query("SELECT 1 FROM app_notification_outbox WHERE dedupe_key=$1", [`equipment-confirmed:${result.id}`])).rowCount, 0);
  }
  await assert.rejects(service.create(member, booking(2, {amountCents: 1})), {code: 'PRICE_CHANGED'});
});

test('only canonical paid state confirms; duplicate and stale events issue one payment and confirmation', async () => {
  const result = await service.create(member, booking(2));
  const session = await sessionFor(result.id);
  await billing.webhook({id: 'evt_unpaid', type: 'checkout.session.completed', livemode: false, data: {object: session}} as any);
  assert.equal((await state(result.id)).status, 'pending');
  const stale = {...session}; paid(session);
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'])
    await billing.webhook({id: 'evt_' + type, type, livemode: false, data: {object: stale}} as any);
  assert.equal((await state(result.id)).status, 'confirmed');
  const rows = await pool.query('SELECT p.price,p.paymentstatus FROM app_equipment_checkout c JOIN payment p ON p.paymentid=c.payment_id WHERE c.reservation_id=$1', [result.id]);
  assert.equal(rows.rows[0].price, '14.00');
  assert.equal(rows.rows[0].paymentstatus, 'paid');
  assert.equal((await pool.query('SELECT 1 FROM payment WHERE reference=$1', [session.id])).rowCount, 1);
  assert.equal((await pool.query('SELECT 1 FROM app_notification_outbox WHERE dedupe_key=$1', [`equipment-confirmed:${result.id}`])).rowCount, 1);
  await assert.rejects(service.update(member, result.id, {expectedRevision: 1}), {code: 'STAFF_REQUIRED'});
});

test('price, identity, currency and live mode mismatches cannot confirm a reservation', async () => {
  const result = await service.create(member, booking());
  const session = paid(await sessionFor(result.id));
  for (const change of [{amount_total: 1}, {currency: 'eur'}, {client_reference_id: '0'}, {livemode: true}, {id: 'cs_other'}])
    await assert.rejects(billing.apply({...session, ...change}), {code: 'PAYMENT_MISMATCH'});
  assert.equal((await state(result.id)).status, 'pending');
  // Restore unpaid state for the next reconciliation.
  Object.assign(session, {status: 'open', payment_status: 'unpaid'});
});

test('same request resumes one checkout; changed request key payload is rejected; pending holds block competitors', async () => {
  const data = booking();
  const first = await service.create(member, data), second = await service.create(member, data);
  assert.equal(first.id, second.id);
  await assert.rejects(service.create(member, {...data, endTime: new Date(new Date(data.endTime).getTime() + 3600000).toISOString()}), {code: 'KEY_REUSED'});
  await assert.rejects(service.create(member, {...data, requestKey: randomUUID()}), {code: 'RESERVATION_CONFLICT'});
  await assert.rejects(billing.checkout(member + 99999, first.id), {code: 'NOT_FOUND'});
  await assert.rejects(billing.cancelPending(member + 99999, first.id), {code: 'NOT_FOUND'});
});

test('a lost Stripe response retries the same charge and original quote even after equipment is renamed', async () => {
  const data = booking();
  const original = provider.sdk.checkout.sessions.create.bind(provider.sdk.checkout.sessions);
  const fail = mock.method(provider.sdk.checkout.sessions, 'create', async (...args: any[]) => {
    await (original as any)(...args);
    throw new Error('Connection lost after provider created checkout');
  });
  try { await assert.rejects(service.create(member, data), {code: 'CHECKOUT_UNAVAILABLE'}); }
  finally { fail.mock.restore(); }
  await pool.query("UPDATE equipment SET name='Renamed payment machine' WHERE equipmentid=$1", [equipment]);
  const resumed = await service.create(member, data);
  assert.equal(resumed.status, 'pending');
  assert.equal(quotes.at(-1)!.line_items![0]!.price_data!.product_data!.name, quotes.at(-2)!.line_items![0]!.price_data!.product_data!.name);
  assert.equal(checkoutKeys.at(-1), checkoutKeys.at(-2));
  assert.equal((await pool.query('SELECT 1 FROM app_equipment_checkout WHERE payer_id=$1 AND request_key=$2', [member, data.requestKey])).rowCount, 1);
  await pool.query("UPDATE equipment SET name='Payment test machine' WHERE equipmentid=$1", [equipment]);
});

test('a definitive checkout creation rejection releases the unpaid hold', async () => {
  const data = booking();
  const fail = mock.method(provider.sdk.checkout.sessions, 'create', async () => {
    throw new Stripe.errors.StripeInvalidRequestError({message: 'Invalid expiry', type: 'invalid_request_error'});
  });
  try { await assert.rejects(service.create(member, data), {code: 'CHECKOUT_UNAVAILABLE'}); }
  finally { fail.mock.restore(); }
  const row = (await pool.query('SELECT reservation_id FROM app_equipment_checkout WHERE request_key=$1', [data.requestKey])).rows[0];
  assert.equal((await state(row.reservation_id)).status, 'cancelled');
  assert.equal((await state(row.reservation_id)).paymentStatus, 'expired');
  await service.create(member, {...data, requestKey: randomUUID()});
});

test('expired or cancelled unpaid checkouts release slots; stale expiry cannot cancel a paid reservation', async () => {
  const data = booking();
  const first = await service.create(member, data);
  assert.equal((await new ReservationModel(pool).cancel(first.id, member)), null);
  await assert.rejects(new ReservationModel(pool).cancelAny(first.id), {code: 'PAYMENT_WORKFLOW_REQUIRED'});
  await billing.cancelPending(member, first.id);
  assert.equal((await state(first.id)).status, 'cancelled');
  await assert.rejects(billing.checkout(member, first.id), {code: 'CHECKOUT_EXPIRED'});
  const second = await service.create(member, {...data, requestKey: randomUUID()});
  const session = await sessionFor(second.id);
  Object.assign(session, {status: 'expired'});
  await pool.query("UPDATE app_equipment_checkout SET hold_until=now()-interval '1 second' WHERE reservation_id=$1", [second.id]);
  await billing.reconcile();
  assert.equal((await state(second.id)).status, 'cancelled');
  assert.equal((await state(second.id)).paymentStatus, 'expired');
  await service.create(member, {...data, requestKey: randomUUID()});
});

test('paid-state reconciliation recovers a missed webhook; no Stripe config fails closed; zero rate needs no payment', async () => {
  const data = booking(), result = await service.create(member, data);
  paid(await sessionFor(result.id));
  await billing.reconcile(member);
  assert.equal((await state(result.id)).status, 'confirmed');
  await assert.rejects(new ReservationService(pool, 'America/New_York').create(member, booking()), {code: 'PAYMENTS_UNAVAILABLE'});
  await pool.query('UPDATE equipment SET hourlyrate=NULL WHERE equipmentid=$1', [equipment]);
  await assert.rejects(service.create(member, booking()), {code: 'RATE_NOT_SET'});
  await pool.query('UPDATE equipment SET hourlyrate=0 WHERE equipmentid=$1', [equipment]);
  const free = await new ReservationService(pool, 'America/New_York').create(member, booking(1, {amountCents: 0}));
  assert.equal(free.status, 'confirmed');
  assert.equal((await pool.query('SELECT 1 FROM app_equipment_checkout WHERE reservation_id=$1', [free.id])).rowCount, 0);
  await pool.query('UPDATE equipment SET hourlyrate=7 WHERE equipmentid=$1', [equipment]);
});

test('signed raw-body webhook verifies payment; forged callbacks and anonymous checkout are rejected', async () => {
  const result = await service.create(member, booking()), session = paid(await sessionFor(result.id));
  const app = createApp(pool, {port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32), studioStripe: provider.config});
  const payload = JSON.stringify({id: 'evt_equipment_signed', object: 'event', livemode: false,
    type: 'checkout.session.completed', data: {object: session}});
  assert.equal((await request(app).post('/api/webhooks/stripe-studios').set('Content-Type', 'application/json').send(payload)).status, 400);
  assert.equal((await state(result.id)).status, 'pending');
  // Every StudioStripe instance shares the SDK resource prototype; mock only provider retrieval.
  const prototype = Object.getPrototypeOf(provider.sdk.checkout.sessions);
  const retrieve = mock.method(prototype, 'retrieve', async (id: string) => sessions.get(id));
  try {
    const signature = provider.sdk.webhooks.generateTestHeaderString({payload, secret: provider.config.webhookSecret});
    for (let i = 0; i < 2; i++) {
      const response = await request(app).post('/api/webhooks/stripe-studios').set('Content-Type', 'application/json').set('stripe-signature', signature).send(payload);
      assert.equal(response.status, 200, response.text);
    }
    assert.equal((await state(result.id)).status, 'confirmed');
    assert.equal((await request(app).post(`/api/reservations/${result.id}/checkout`).send({})).status, 401);
  } finally { retrieve.mock.restore(); }
});

test('authenticated reservation HTTP flow requires payment, enforces CSRF and confirms on verified return', async () => {
  const app = createApp(pool, {port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32), studioStripe: provider.config});
  const agent = request.agent(app), login = await agent.post('/api/auth/demo').send({role: 'member'});
  assert.equal(login.status, 200);
  agent.set('Authorization', 'Bearer ' + login.body.data.accessToken);
  const prototype = Object.getPrototypeOf(provider.sdk.checkout.sessions);
  const create = mock.method(prototype, 'create', (...args: any[]) => (provider.sdk.checkout.sessions.create as any)(...args));
  const retrieve = mock.method(prototype, 'retrieve', (id: string) => Promise.resolve(sessions.get(id)));
  try {
    const start = Date.now() + 5 * 86400000;
    const body = {equipmentId: equipment, startTime: new Date(start).toISOString(),
      endTime: new Date(start + 2 * 3600000).toISOString(), requestKey: randomUUID(), amountCents: 1400};
    assert.equal((await agent.post('/api/reservations').send(body)).status, 403);
    agent.set('X-CSRF-Token', login.body.data.csrfToken);
    const response = await agent.post('/api/reservations').send(body);
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.data.status, 'pending');
    assert.equal(response.body.data.amountCents, 1400);
    assert.match(response.body.data.checkoutUrl, /^https:\/\/checkout.stripe.com\//);
    paid(await sessionFor(response.body.data.id));
    const mine = await agent.get('/api/reservations');
    assert.equal(mine.status, 200, mine.text);
    const confirmed = mine.body.data.find((r: any) => r.id === response.body.data.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.paymentStatus, 'paid');
  } finally { create.mock.restore(); retrieve.mock.restore(); }
});
