import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { StaffModel } from '../../src/models/StaffModel.js';
import { waiverAcceptance } from '../helpers/waiver.js';

// Moving bookings off a machine: what "Review move" promises, "Confirm move" keeps; online-paid
// bookings get a message meant for staff, worded by whose checkout it is; ids past the INTEGER
// columns are refused, not a 500.
const database = `arbor_move_checks_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let app: ReturnType<typeof createApp>, administrator: Session, member: Session;
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' });
  const login = async (role: string) => (await request(app).post('/api/auth/demo').send({ role })).body.data;
  administrator = await login('admin'); member = await login('member');
  for (const w of (await send('get', '/me/waivers', undefined, member)).body.data)
    assert.equal((await send('post', `/me/waivers/${w.id}/sign`, waiverAcceptance(w), member)).status, 200);
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

function send(method: 'get' | 'post' | 'patch', path: string, body?: object, who = administrator) {
  const req = request(app)[method]('/api' + path).set('Authorization', 'Bearer ' + who.accessToken);
  return method === 'get' ? req : req.set('X-CSRF-Token', who.csrfToken).send(body ?? {});
}
async function machine(rate: number | null) {
  return (await pool.query('INSERT INTO equipment(name,status,hourlyrate,waiverrequired) VALUES($1,$2,$3,false) RETURNING equipmentid',
    [`Move check ${randomUUID().slice(0, 8)}`, 'available', rate])).rows[0].equipmentid as number;
}
let day = 2;
/** A one-hour member booking on its own day, so bookings never collide. */
async function booking(equipmentId: number) {
  day++;
  return (await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Makerspace',(NOW()+$3 * INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+$3 * INTERVAL '1 day'+INTERVAL '1 hour') AT TIME ZONE 'UTC','confirmed')
    RETURNING reservationid AS id,revision`, [member.user.id, equipmentId, day])).rows[0] as { id: number; revision: number };
}
async function deskPayment(reservationId: number, status: 'paid' | 'pending', amount: string) {
  const paymentId = await new StaffModel(pool).createPayment(member.user.id, null, amount, status, 'unspecified', '', 'Equipment booking', administrator.user.id);
  await pool.query('UPDATE reservation SET payment_id=$2 WHERE reservationid=$1', [reservationId, paymentId]);
}
async function checkout(reservationId: number, status: 'paid' | 'pending', payerId = member.user.id) {
  await pool.query(`INSERT INTO app_equipment_checkout(reservation_id,payer_id,request_key,equipment_name,hourly_cents,hours,amount_cents,status)
    VALUES($1,$2,$3,'Move check',1200,1,1200,$4)`, [reservationId, payerId, randomUUID(), status]);
}
const moveTo = (source: number, b: { id: number; revision: number }, target: number, confirm?: object) =>
  send('post', `/admin/equipment/${source}/bookings/${b.id}/${confirm ? 'move' : 'review-move'}`, { expectedRevision: b.revision, equipmentId: target, ...confirm });

test('a move reviewed onto a machine with no rate can be confirmed', async () => {
  const source = await machine(12), target = await machine(null), b = await booking(source);
  const review = await moveTo(source, b, target);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.data.priceSnapshot, null);
  // The page sends back exactly what the review returned.
  const moved = await moveTo(source, b, target, { expectedRate: review.body.data.rate, expectedPrice: review.body.data.priceSnapshot });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.data.equipmentId, target);
  assert.equal(moved.body.data.priceSnapshot, null);
});

test('review refuses a move that confirming would refuse for its payment', async () => {
  // Paid at the desk for $12: a $20/hour machine would change a settled amount.
  const source = await machine(12), dearer = await machine(20), same = await machine(12), b = await booking(source);
  await deskPayment(b.id, 'paid', '12.00');
  const refused = await moveTo(source, b, dearer);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'PAYMENT_SETTLED');
  const review = await moveTo(source, b, same);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const moved = await moveTo(source, b, same, { expectedRate: review.body.data.rate, expectedPrice: review.body.data.priceSnapshot });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  // An unpaid desk charge can't follow a move to a machine with no price.
  const unpriced = await machine(null), owed = await booking(source);
  await deskPayment(owed.id, 'pending', '12.00');
  const noPrice = await moveTo(source, owed, unpriced);
  assert.equal(noPrice.status, 409);
  assert.equal(noPrice.body.error.code, 'PRICE_NOT_CONFIGURED');
  assert.equal((await pool.query('SELECT equipmentid FROM reservation WHERE reservationid=$1', [owed.id])).rows[0].equipmentid, source);
});

test('online-paid bookings stay put with a message for staff, not "contact staff"', async () => {
  const source = await machine(12), target = await machine(12);
  const paid = await booking(source);
  await checkout(paid.id, 'paid');
  for (const response of [
    await moveTo(source, paid, target),
    await send('patch', `/admin/reservations/${paid.id}`, { equipmentId: target, expectedRevision: paid.revision }),
  ]) {
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
    assert.match(response.body.error.message, /paid online/);
    assert.doesNotMatch(response.body.error.message, /Contact staff/);
  }
  const waiting = await booking(source);
  await checkout(waiting.id, 'pending');
  const move = await moveTo(source, waiting, target);
  assert.equal(move.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
  assert.match(move.body.error.message, /waiting for the member’s online payment/);
  const cancel = await send('post', `/admin/equipment/${source}/bookings/${waiting.id}/cancel`, { expectedRevision: waiting.revision });
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
  assert.match(cancel.body.error.message, /can’t be cancelled yet/);
  assert.doesNotMatch(cancel.body.error.message, /Stripe checkout|hold is released/);

  // Staff who booked for the member opened the checkout themselves: they can cancel it now.
  const own = await booking(source);
  await checkout(own.id, 'pending', administrator.user.id);
  const ownMove = await moveTo(source, own, target);
  assert.equal(ownMove.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
  assert.match(ownMove.body.error.message, /You opened an online checkout.*Cancel checkout/);
  for (const ownCancel of [
    await send('post', `/admin/equipment/${source}/bookings/${own.id}/cancel`, { expectedRevision: own.revision }),
    await send('post', `/admin/reservations/${own.id}/cancel`, {}),
  ]) {
    assert.equal(ownCancel.status, 409);
    assert.equal(ownCancel.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
    assert.match(ownCancel.body.error.message, /You opened an online checkout.*Cancel checkout under My reservations/);
    assert.doesNotMatch(ownCancel.body.error.message, /member’s|expires unpaid/);
  }
  // Another staff member's checkout is neither this staff member's nor the member's.
  const colleague = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status,primary_role)
    VALUES('Other','Staff','move-check-staff@example.invalid','unused','0000000000','active','staff') RETURNING userid`)).rows[0].userid;
  const theirs = await booking(source);
  await checkout(theirs.id, 'pending', colleague);
  const theirsCancel = await send('post', `/admin/reservations/${theirs.id}/cancel`, {});
  assert.equal(theirsCancel.body.error.code, 'PAYMENT_WORKFLOW_REQUIRED');
  assert.match(theirsCancel.body.error.message, /another staff member opened/);
  assert.doesNotMatch(theirsCancel.body.error.message, /member’s|You opened/);
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=ANY($1)', [[own.id, theirs.id]])).rows.every(r => r.status === 'confirmed'), true);
});

test('ids past the database integer range are refused as bad input, not a server error', async () => {
  const tooBig = '2147483648', id = await machine(12), b = await booking(id);
  const window = { startTime: new Date(Date.now() + 40 * 86400000).toISOString(), endTime: new Date(Date.now() + 40 * 86400000 + 3600000).toISOString() };
  const responses = [
    await send('get', `/equipment/${tooBig}/quote?hours=1`, undefined, member),
    await send('post', '/reservations', { equipmentId: Number(tooBig), ...window }, member),
    await send('post', `/reservations/${tooBig}/cancel`, {}, member),
    await send('post', `/reservations/${tooBig}/checkout`, {}, member),
    await send('post', `/reservations/${tooBig}/cancel-checkout`, {}, member),
    await send('post', '/reservations', { equipmentId: id, userId: Number(tooBig), ...window }),
    await send('get', `/admin/reservations?equipmentId=${tooBig}`),
    await send('get', `/admin/reservations?userId=${tooBig}`),
    await send('patch', `/admin/reservations/${tooBig}`, { expectedRevision: 1 }),
    await send('patch', `/admin/reservations/${b.id}`, { equipmentId: Number(tooBig), expectedRevision: b.revision }),
    await send('post', `/admin/reservations/${tooBig}/cancel`, {}),
    await send('get', `/admin/equipment/${tooBig}`),
    await send('get', `/admin/equipment/${tooBig}/bookings`),
    await send('post', `/admin/equipment/${id}/bookings/${tooBig}/review-move`, { expectedRevision: 1, equipmentId: id }),
    await send('post', `/admin/equipment/${id}/bookings/${b.id}/review-move`, { expectedRevision: b.revision, equipmentId: Number(tooBig) }),
    await send('post', `/admin/equipment/${tooBig}/bookings/${b.id}/cancel`, { expectedRevision: b.revision }),
  ];
  for (const [n, response] of responses.entries()) {
    assert.equal(response.status, 400, `request ${n}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'INVALID_INPUT');
  }
  assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1', [b.id])).rows[0].status, 'confirmed');
});
