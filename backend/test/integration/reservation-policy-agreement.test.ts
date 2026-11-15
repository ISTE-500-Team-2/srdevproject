import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { Pool } from 'pg';
import Stripe from 'stripe';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { equipmentPrice } from '../../src/equipmentPricing.js';
import { ReservationModel, type ReservationWrite } from '../../src/models/ReservationModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { StudioStripe } from '../../src/studios/stripe.js';

// Create, staff update and Stripe checkout share one price result and one set of
// resource rules; the bounds that intentionally differ are pinned here too.
const database = 'arbor_reservation_policy_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const zone = 'America/New_York';
const provider = new StudioStripe({ key: 'sk_test_policy_fake', webhookSecret: 'whsec_policy_fake', origin: 'http://localhost:8080' });
const checkouts: Stripe.Checkout.SessionCreateParams[] = [];
const hour = 3_600_000;
let created = false, member = 0, admin = 0, memberToken = '', memberCsrf = '';
let app: ReturnType<typeof createApp>;
let day = 0;

// Results are rows or a preview; tests only read reservation fields.
type Row = { id: number; revision: number; status: string; startTime: Date; priceSnapshot: unknown; [column: string]: any };
const paid = () => new ReservationService(pool, zone, provider);
const plain = () => new ReservationService(pool, zone);
const create = async (service: ReservationService, actor: number, body: Record<string, unknown>) =>
  (await service.create(actor, body)) as unknown as Row;
const update = async (id: number, body: Record<string, unknown>) =>
  (await plain().update(admin, id, body)) as unknown as Row;

/** A fresh future day per call, so fixtures never meet each other's cooldowns. */
function slot(hours = 1, offsetMinutes = 0) {
  const start = Date.UTC(2030, 2, 1, 14) + day++ * 86_400_000 + offsetMinutes * 60_000;
  return { startTime: new Date(start).toISOString(), endTime: new Date(start + hours * hour).toISOString() };
}
function shifted(base: { startTime: string | Date }, minutes: number, hours = 1) {
  const start = new Date(base.startTime).getTime() + minutes * 60_000;
  return { startTime: new Date(start).toISOString(), endTime: new Date(start + hours * hour).toISOString() };
}
async function equipment(rate: string | null, status = 'available') {
  return (await pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
    VALUES($1,$2,$3,false,'Policy lab') RETURNING equipmentid`, ['Policy machine ' + randomUUID(), status, rate])).rows[0].equipmentid as number;
}
async function room(status = 'available') {
  return (await pool.query("INSERT INTO room(name,location,status) VALUES($1,'Policy wing',$2) RETURNING roomid",
    ['Policy room ' + randomUUID(), status])).rows[0].roomid as number;
}
// Compile-time only (never called): the model accepts exactly one resource.
export function onlyOneResource(model: ReservationModel, row: Omit<ReservationWrite, 'equipmentId' | 'roomId'>) {
  void model.create({ ...row, equipmentId: 1 });
  void model.update(1, { ...row, roomId: 1 });
  // @ts-expect-error both resources
  void model.create({ ...row, equipmentId: 1, roomId: 2 });
  // @ts-expect-error neither resource
  void model.update(1, { ...row });
}
async function code(work: Promise<unknown>) {
  try { await work; } catch (error) { return (error as { code?: string }).code; }
  return 'OK';
}

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: zone, jwtKey: randomBytes(32) });
  const login = await request(app).post('/api/auth/demo').send({ role: 'member' });
  assert.equal(login.status, 200, login.text);
  member = login.body.data.user.id;
  memberToken = login.body.data.accessToken;
  memberCsrf = login.body.data.csrfToken;
  const staff = await request(app).post('/api/auth/demo').send({ role: 'admin' });
  assert.equal(staff.status, 200, staff.text);
  admin = staff.body.data.user.id;
  await pool.query("UPDATE user_membership SET startdate=now()-interval '1 day',end_date='2031-01-01',status='active' WHERE userid=$1", [member]);
  mock.method(provider.sdk.checkout.sessions, 'create', async (params: Stripe.Checkout.SessionCreateParams) => {
    checkouts.push(params);
    const id = 'cs_policy_' + params.client_reference_id;
    return { id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid',
      client_reference_id: params.client_reference_id, metadata: params.metadata, currency: 'usd',
      amount_total: Number(params.line_items![0]!.quantity) * Number(params.line_items![0]!.price_data!.unit_amount),
      url: 'https://checkout.stripe.com/' + id } as unknown as Stripe.Checkout.Session;
  });
});
after(async () => {
  mock.restoreAll();
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

test('create, Stripe checkout and staff update carry the same equipment price', async () => {
  const machine = await equipment('12.35');
  const threeHours = (await equipmentPrice(pool, machine, 3))!;
  const twoHours = (await equipmentPrice(pool, machine, 2))!;
  assert.equal(threeHours.totalCents, 3705);

  const held = await create(paid(), member, { equipmentId: machine, ...slot(3), requestKey: randomUUID(), expectedPrice: threeHours });
  assert.equal(held.status, 'pending');
  assert.equal(held.amountCents, threeHours.totalCents);
  assert.deepEqual(held.priceSnapshot, threeHours);
  const checkout = (await pool.query('SELECT hourly_cents,hours,amount_cents FROM app_equipment_checkout WHERE reservation_id=$1', [held.id])).rows[0];
  assert.deepEqual(checkout, { hourly_cents: threeHours.hourlyRateCents, hours: threeHours.hours, amount_cents: threeHours.totalCents });
  const line = checkouts.at(-1)!.line_items![0]!;
  assert.equal(Number(line.price_data!.unit_amount) * Number(line.quantity), threeHours.totalCents);
  assert.equal((await pool.query('SELECT p.price FROM payment p JOIN reservation r ON r.payment_id=p.paymentid WHERE r.reservationid=$1', [held.id])).rows[0].price, '37.05');

  // Without Stripe the same quote confirms; a staff move to three hours stores the identical snapshot.
  const booked = await create(plain(), member, { equipmentId: machine, ...slot(2), expectedPrice: twoHours });
  assert.equal(booked.status, 'confirmed');
  assert.deepEqual(booked.priceSnapshot, twoHours);
  const moved = await update(booked.id, { ...shifted(booked, 0, 3), expectedRevision: booked.revision, expectedPrice: threeHours });
  assert.deepEqual(moved.priceSnapshot, threeHours);
  assert.deepEqual((await new ReservationModel(pool).find(moved.id))!.priceSnapshot, held.priceSnapshot);
});

test('create and update reject the same availability, overlap and cooldown conflicts', async () => {
  const machine = await equipment('0'), broken = await equipment('0', 'maintenance');
  const space = await room(), closed = await room('maintenance');
  const takenEquipment = slot(), takenRoom = slot();
  await create(plain(), member, { equipmentId: machine, ...takenEquipment });
  await create(plain(), member, { roomId: space, ...takenRoom });
  const movable = await create(plain(), member, { equipmentId: machine, ...slot() });

  const cases: [string, Record<string, unknown>, string][] = [
    ['equipment overlap', { equipmentId: machine, ...shifted(takenEquipment, 30) }, 'RESERVATION_CONFLICT'],
    ['equipment cooldown', { equipmentId: machine, ...shifted(takenEquipment, 70) }, 'RESERVATION_COOLDOWN'],
    ['unavailable equipment', { equipmentId: broken, ...slot() }, 'EQUIPMENT_UNAVAILABLE'],
    ['room overlap', { roomId: space, ...shifted(takenRoom, 30) }, 'RESERVATION_CONFLICT'],
    ['room cooldown', { roomId: space, ...shifted(takenRoom, 70) }, 'RESERVATION_COOLDOWN'],
    ['unavailable room', { roomId: closed, ...slot() }, 'ROOM_UNAVAILABLE'],
  ];
  for (const [name, target, expected] of cases) {
    assert.equal(await code(create(plain(), member, target)), expected, `create: ${name}`);
    const resource = 'roomId' in target ? { equipmentId: null } : { roomId: null };
    assert.equal(await code(update(movable.id, { ...resource, ...target, expectedRevision: movable.revision })), expected, `update: ${name}`);
  }
  // An update never conflicts with the booking it is moving.
  const ownSlot = shifted(movable, 30);
  const moved = await update(movable.id, { ...ownSlot, expectedRevision: movable.revision });
  assert.equal(new Date(moved.startTime).toISOString(), ownSlot.startTime);
});

test('create checks its payable bound before conflicts and the supported range after; update only the latter', async () => {
  const busy = slot();
  const tooLarge = await equipment('200000.00'); // 20,000,000 cents: payable online, above the supported range
  const unpayable = await equipment('50000000.00'); // above the online payment cap
  const tiny = await equipment('0.25'); // below Stripe's minimum
  const unpriced = await equipment(null);
  for (const machine of [tooLarge, unpayable])
    await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
      VALUES($1,$2,'Policy lab',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed')`,
    [admin, machine, busy.startTime, busy.endTime]);

  assert.equal(await code(create(plain(), member, { equipmentId: tooLarge, ...busy })), 'RESERVATION_CONFLICT');
  assert.equal(await code(create(plain(), member, { equipmentId: tooLarge, ...slot() })), 'INVALID_PRICE');
  assert.equal(await code(create(plain(), member, { equipmentId: unpayable, ...busy })), 'INVALID_RATE');
  assert.equal(await code(create(plain(), member, { equipmentId: tooLarge, ...busy, amountCents: 1 })), 'PRICE_CHANGED');
  assert.equal(await code(create(plain(), member, { equipmentId: tiny, ...slot() })), 'INVALID_RATE');
  assert.equal(await code(create(plain(), member, { equipmentId: unpriced, ...slot() })), 'RATE_NOT_SET');

  const free = await equipment('0');
  const booking = await create(plain(), member, { equipmentId: free, ...slot() });
  assert.equal(await code(update(booking.id, { equipmentId: tooLarge, expectedRevision: booking.revision })), 'INVALID_PRICE');
  const legacy = await update(booking.id, { equipmentId: unpriced, expectedRevision: booking.revision });
  assert.equal(legacy.priceSnapshot, null);
  const cheap = await update(booking.id, { equipmentId: tiny, expectedRevision: legacy.revision });
  assert.equal((cheap.priceSnapshot as { totalCents: number }).totalCents, 25);
});

test('member and staff cancellation share payment, audit and notification effects', async () => {
  const machine = await equipment('7.00');
  const cancel = (id: number) => request(app).post(`/api/reservations/${id}/cancel`)
    .set('Authorization', 'Bearer ' + memberToken).set('X-CSRF-Token', memberCsrf).send({});
  const effects = async (id: number) => ({
    payment: (await pool.query('SELECT p.paymentstatus FROM payment p JOIN reservation r ON r.payment_id=p.paymentid WHERE r.reservationid=$1', [id])).rows[0].paymentstatus,
    audit: (await pool.query('SELECT action,actor_id,subject_id,reason,before_state FROM app_staff_audit WHERE entity_id=$1 AND action LIKE $2', [id, 'reservation%cancelled'])).rows,
    notice: (await pool.query('SELECT userid,payload FROM app_notification_outbox WHERE dedupe_key=$1', [`reservation-cancelled:${id}`])).rows,
  });

  const mine = await create(plain(), member, { equipmentId: machine, ...slot(), expectedPrice: await equipmentPrice(pool, machine, 1) });
  assert.equal((await effects(mine.id)).payment, 'pending');
  const cancelled = await cancel(mine.id);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.data.status, 'cancelled');
  const memberEffects = await effects(mine.id);
  assert.equal(memberEffects.payment, 'void');
  assert.deepEqual(memberEffects.audit.map(row => [row.action, row.actor_id, row.subject_id, row.reason, row.before_state]),
    [['reservation.cancelled', member, member, 'Member cancellation with at least 24 hours notice', null]]);
  assert.equal(memberEffects.notice.length, 1);
  assert.equal(memberEffects.notice[0].userid, member);

  const theirs = await create(plain(), member, { equipmentId: machine, ...slot(), expectedPrice: await equipmentPrice(pool, machine, 1) });
  await plain().cancelAny(admin, theirs.id);
  const staffEffects = await effects(theirs.id);
  assert.equal(staffEffects.payment, 'void');
  assert.deepEqual(staffEffects.audit.map(row => [row.action, row.actor_id, row.subject_id, row.reason]),
    [['reservation.override.cancelled', admin, member, 'Staff reservation override']]);
  assert.equal(staffEffects.notice[0].userid, member);
  assert.deepEqual(Object.keys(staffEffects.notice[0].payload).sort(), Object.keys(memberEffects.notice[0].payload).sort());

  // Unchanged member responses: nothing left to cancel, and short notice.
  const again = await cancel(mine.id);
  assert.deepEqual([again.status, again.body.error.code, again.body.error.message],
    [404, 'NOT_FOUND', 'No cancellable reservation was found for this account.']);
  const soon = new Date(Date.now() + 2 * hour);
  const close = (await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Policy lab',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed') RETURNING reservationid`,
  [member, machine, soon, new Date(soon.getTime() + hour)])).rows[0].reservationid;
  const late = await cancel(close);
  assert.deepEqual([late.status, late.body.error.code, late.body.error.message],
    [409, 'CANCELLATION_NOTICE_REQUIRED', 'Equipment cancellations require at least 24 hours notice. Contact staff.']);
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [close])).rows[0].status, 'confirmed');
});
