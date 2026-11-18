import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import type Stripe from 'stripe';
import { createApp } from '../../src/app.js';
import { EquipmentBilling } from '../../src/billing/equipment.js';
import { PassBilling } from '../../src/billing/passes.js';
import { MembershipBilling } from '../../src/billing/service.js';
import { ReservationModel } from '../../src/models/ReservationModel.js';
import { StaffModel } from '../../src/models/StaffModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { stripeEvent, stripeMock, type StripeFixture } from '../helpers/stripeFixtures.js';

type Plan = NonNullable<Awaited<ReturnType<StaffModel['plan']>>>;
type Refund = StripeFixture<Stripe.Refund>;
type Session = StripeFixture<Stripe.Checkout.Session>;
const database = 'arbor_staff_refunds_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const provider = new StudioStripe({ key: 'sk_test_fixture', webhookSecret: 'whsec_fixture', origin: 'http://localhost:8080' });
const equipmentBilling = new EquipmentBilling(pool, provider), passes = new PassBilling(pool, provider);
const memberships = new MembershipBilling(pool, provider);
const reservations = new ReservationService(pool, 'America/New_York', provider);
const stripe = stripeMock(provider);
let created = false, member: number, staff: number, admin: number, staffMembership: number, equipment: number, day: Plan, slot = 0;

// A small Stripe stand-in: checkout sessions by id, refunds per payment intent (newest first), idempotent creates.
const sessions = new Map<string, Session>();
const refunds: Refund[] = [], keys: string[] = [], byKey = new Map<string, Refund>();
let nextStatus: Stripe.Refund['status'] = 'succeeded';
stripe.checkoutSessionCreate(async params => {
  const id = 'cs_refund_' + params!.client_reference_id;
  sessions.set(id, { id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid', client_reference_id: params!.client_reference_id,
    metadata: params!.metadata as Record<string, string>, currency: 'usd', url: 'https://checkout.stripe.com/' + id,
    amount_total: Number(params!.line_items![0]!.quantity) * Number(params!.line_items![0]!.price_data!.unit_amount) });
  return sessions.get(id)!;
});
stripe.checkoutSessionRetrieve(async id => sessions.get(id)!);
stripe.refundList(async params => ({ data: refunds.filter(f => f.payment_intent === params?.payment_intent), has_more: false }));
stripe.refundRetrieve(async id => refunds.find(f => f.id === id)!);
stripe.refundCreate(async (params, options) => {
  const key = options!.idempotencyKey!;
  keys.push(key);
  if (byKey.has(key)) return byKey.get(key)!;
  const refund: Refund = { id: 're_' + randomBytes(4).toString('hex'), object: 'refund', status: nextStatus, amount: params!.amount!,
    currency: 'usd', payment_intent: params!.payment_intent as string, metadata: params!.metadata as Record<string, string> ?? {} };
  refunds.unshift(refund); byKey.set(key, refund);
  return refund;
});

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  await pool.query("UPDATE user_membership SET startdate=now()-interval '1 day',end_date='2035-01-01',status='active' WHERE userid=$1", [member]);
  staff = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status,primary_role)
    VALUES('Refund','Staff','refund-staff@example.invalid','unused','0000000000','active','staff') RETURNING userid`)).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'", [staff]);
  // Staff are members too, so they can book machine time for themselves.
  staffMembership = (await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status,statusdesc)
    VALUES($1,1,now()-interval '1 day','2035-01-01','active','Staff refund fixture') RETURNING membershipid`, [staff])).rows[0].membershipid;
  admin = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  equipment = (await pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
    VALUES('Refund test machine','available',7,false,'Makerspace') RETURNING equipmentid`)).rows[0].equipmentid;
  day = (await new StaffModel(pool).plan((await pool.query("SELECT tierid FROM membership_tiers WHERE kind='day_pass' LIMIT 1")).rows[0].tierid))!;
});
after(async () => {
  mock.restoreAll();
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

/** A one-hour, $7.00 booking for `holder`, made by `payer`; paid by card unless `pay` is false. */
async function booking(pay = true, payer = member, holder = payer) {
  const start = Date.UTC(2031, 0, 2 + slot++, 15);
  const { id } = await reservations.create(payer, { equipmentId: equipment, startTime: new Date(start).toISOString(),
    endTime: new Date(start + 3600000).toISOString(), requestKey: randomUUID(), amountCents: 700,
    ...(holder === payer ? {} : { userId: holder }) }) as unknown as { id: number };
  const checkout = (await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [id])).rows[0].checkout_id;
  const session = sessions.get(checkout)!, intent = 'pi_' + checkout;
  if (pay) {
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
    await equipmentBilling.apply(session as Stripe.Checkout.Session);
  }
  const state = async () => (await pool.query(`SELECT c.refund_id,c.refund_status,p.paymentstatus AS payment
    FROM app_equipment_checkout c JOIN reservation r ON r.reservationid=c.reservation_id JOIN payment p ON p.paymentid=r.payment_id
    WHERE c.reservation_id=$1`, [id])).rows[0];
  return { id, intent, session, state };
}
/** An online day pass for tomorrow, bought by `holder` for $15.00 by card. */
async function cardPass(holder: number) {
  const model = new StaffModel(pool), id = randomUUID(), intent = 'pi_pass_' + randomBytes(4).toString('hex');
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const pass = await model.createPass(holder, day, date, holder, 'Staff refund fixture');
  const payment = await model.createPayment(holder, null, '15.00', 'paid', 'card', 'cs_' + id, 'Online day pass', holder);
  await model.linkPassPayment(pass, payment);
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,status,payment_intent,pass_id,payment_id)
    VALUES($1,$2,$3,$4,$5,1500,'paid',$6,$7,$8)`, [id, holder, day.id, date, day, intent, pass, payment]);
  return { id, intent };
}
const ledgerRow = async (filter: (row: { equipmentReservationId: number | null; passCheckoutId: string | null }) => boolean) =>
  (await new StaffModel(pool).payments(member)).find(filter)!;
const notices = async (pattern: string) =>
  (await pool.query(`SELECT userid,kind,payload FROM app_notification_outbox WHERE dedupe_key LIKE $1 ORDER BY id`, [pattern])).rows;

test('staff refund a cancelled card-paid booking once, and the payment, ledger and booking say refunded', async () => {
  const paid = await booking();
  assert.ok(await new ReservationModel(pool).cancel(paid.id, member), 'members may cancel a paid booking a day ahead');
  const due = await ledgerRow(row => row.equipmentReservationId === paid.id);
  assert.match(due.planName, /\(cancelled; refund due\)$/);
  assert.equal(due.refundStatus, null);
  assert.equal(due.passCheckoutId, null);

  await assert.rejects(equipmentBilling.refund(member, paid.id, 'Not staff'), { code: 'STAFF_REQUIRED' });
  await assert.rejects(equipmentBilling.refund(staff, paid.id, ''), { code: 'INVALID_INPUT' });
  nextStatus = 'succeeded';
  assert.deepEqual(await equipmentBilling.refund(staff, paid.id, 'Member cancelled a day ahead'), { status: 'succeeded' });
  assert.equal(keys.at(-1), `equipment-refund:${paid.id}`);
  assert.deepEqual(byKey.get(keys.at(-1)!)!.amount, 700);
  assert.deepEqual(await paid.state(), { refund_id: refunds[0]!.id, refund_status: 'succeeded', payment: 'refunded' });
  // A second click changes nothing and refunds nothing more.
  assert.deepEqual(await equipmentBilling.refund(staff, paid.id, 'Member cancelled a day ahead'), { status: 'succeeded' });
  assert.equal(refunds.filter(f => f.payment_intent === paid.intent).length, 1);

  const done = await ledgerRow(row => row.equipmentReservationId === paid.id);
  assert.equal(done.status, 'refunded');
  assert.equal(done.refundStatus, 'succeeded');
  assert.doesNotMatch(done.planName, /refund due/);
  assert.equal((await new ReservationModel(pool).find(paid.id))!.paymentStatus, 'refunded');
  assert.deepEqual((await notices(`equipment-refund:${paid.id}:%`)).map(n => n.kind), ['payment_refunded']);
  const audit = (await pool.query(`SELECT actor_id,subject_id,reason FROM app_staff_audit WHERE action='billing.refund.requested'
    AND entity_type='payment' AND entity_id=$1`, [done.id])).rows;
  assert.deepEqual(audit, [{ actor_id: staff, subject_id: member, reason: 'Member cancelled a day ahead' }]);
});

test('an unpaid or unknown booking has nothing to refund', async () => {
  const unpaid = await booking(false);
  await assert.rejects(equipmentBilling.refund(staff, unpaid.id, 'Nothing was paid'), { code: 'NOT_PAID' });
  await assert.rejects(equipmentBilling.refund(staff, 999999, 'No such booking'), { code: 'NOT_FOUND' });
});

test('a refund made in the Stripe dashboard is recorded from its webhooks, in order, and a later failure restores the payment', async () => {
  const paid = await booking();
  const refund: Refund = { id: 're_dashboard_' + randomBytes(3).toString('hex'), object: 'refund', status: 'pending', amount: 700,
    currency: 'usd', payment_intent: paid.intent, metadata: {} };
  refunds.unshift(refund);
  const deliver = (type: 'refund.created' | 'refund.updated' | 'refund.failed') =>
    equipmentBilling.webhook(stripeEvent('evt_' + randomUUID(), type, { ...refund }));

  await deliver('refund.created');
  assert.deepEqual(await paid.state(), { refund_id: refund.id, refund_status: 'pending', payment: 'paid' });
  refund.status = 'succeeded';
  await deliver('refund.updated');
  await deliver('refund.updated');
  assert.deepEqual(await paid.state(), { refund_id: refund.id, refund_status: 'succeeded', payment: 'refunded' });
  assert.equal((await notices(`equipment-refund:${paid.id}:%`)).length, 1, 'one refund email for repeated events');
  // The refund is in place, so staff aren't offered another one.
  assert.equal((await ledgerRow(row => row.equipmentReservationId === paid.id)).refundStatus, 'succeeded');

  refund.status = 'failed';
  await deliver('refund.failed');
  assert.deepEqual(await paid.state(), { refund_id: refund.id, refund_status: 'failed', payment: 'paid' });
  assert.match((await notices(`equipment-refund-failed:${paid.id}:%`))[0].payload.instructions, /did not go through/);

  // Another product's refund is not this booking's business.
  await equipmentBilling.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created',
    { id: 're_other', object: 'refund', status: 'succeeded', amount: 700, currency: 'usd', payment_intent: 'pi_not_equipment' }));
});

test('staff refund a card day pass inside the member cancellation window, and the pass is cancelled', async () => {
  const { id, intent } = await cardPass(member);
  await assert.rejects(passes.cancel(member, id), { code: 'CANCELLATION_NOTICE' }, 'too late for the member to cancel');

  const listed = await ledgerRow(row => row.passCheckoutId === id);
  assert.equal(listed.equipmentReservationId, null);
  assert.equal(listed.refundStatus, null);
  await assert.rejects(passes.staffRefund(member, id, 'Not staff'), { code: 'STAFF_REQUIRED' });
  await assert.rejects(passes.staffRefund(staff, randomUUID(), 'No such pass'), { code: 'NOT_FOUND' });
  nextStatus = 'succeeded';
  assert.deepEqual(await passes.staffRefund(staff, id, 'Bought for the wrong date'), { status: 'succeeded' });
  assert.equal(keys.at(-1), `daypass-refund:${id}`, 'the same key as a member cancellation, so the two never refund twice');
  assert.deepEqual(await passes.staffRefund(staff, id, 'Bought for the wrong date'), { status: 'succeeded' });
  assert.equal(refunds.filter(f => f.payment_intent === intent).length, 1);
  const after = (await pool.query(`SELECT c.status,c.refund_status,d.status AS pass,d.statusdesc,p.paymentstatus AS payment
    FROM app_pass_checkout c JOIN day_pass d ON d.dayid=c.pass_id JOIN payment p ON p.paymentid=c.payment_id WHERE c.id=$1`, [id])).rows[0];
  assert.deepEqual(after, { status: 'cancelled', refund_status: 'succeeded', pass: 'cancelled', statusdesc: 'Refunded to the original card', payment: 'refunded' });
  assert.equal((await ledgerRow(row => row.passCheckoutId === id)).refundStatus, 'succeeded');
});

test('the refund routes need payment permission and the CSRF token', async () => {
  const paid = await booking();
  const app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
    allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York', jwtKey: randomBytes(32), studioStripe: provider.config });
  // The app builds its own Stripe client; its resources share the SDK prototypes this provider's do.
  const sdk = provider.sdk.refunds;
  mock.method(Object.getPrototypeOf(sdk), 'list', (params: Stripe.RefundListParams) => sdk.list(params));
  mock.method(Object.getPrototypeOf(sdk), 'create', (params: Stripe.RefundCreateParams, options: Stripe.RequestOptions) => sdk.create(params, options));
  const login = async (role: string) => (await request(app).post('/api/auth/demo').send({ role })).body.data;
  const post = (who: { accessToken: string; csrfToken?: string }, path: string) => request(app).post('/api' + path)
    .set('Authorization', 'Bearer ' + who.accessToken).set(who.csrfToken ? { 'X-CSRF-Token': who.csrfToken } : {}).send({ reason: 'Route check' });
  const admin = await login('admin'), demoMember = await login('member');
  assert.equal((await post(demoMember, `/billing-management/equipment/${paid.id}/refund`)).status, 403);
  assert.equal((await post({ accessToken: admin.accessToken }, `/billing-management/equipment/${paid.id}/refund`)).status, 403);
  const refunded = await post(admin, `/billing-management/equipment/${paid.id}/refund`);
  assert.equal(refunded.status, 200, refunded.text);
  assert.deepEqual(refunded.body.data, { status: 'succeeded' });
  const missing = await post(admin, `/billing-management/passes/${randomUUID()}/refund`);
  assert.equal(missing.status, 404, missing.text);
});

test('a booking staff made and paid for a member refunds to that card, so the refund notices go to the payer', async () => {
  const assisted = await booking(true, staff, member);
  nextStatus = 'succeeded';
  assert.deepEqual(await equipmentBilling.refund(staff, assisted.id, 'Desk booking cancelled'), { status: 'succeeded' });
  const refund = refunds[0]!;
  assert.equal(refund.payment_intent, assisted.intent);
  refund.status = 'failed';
  await equipmentBilling.webhook(stripeEvent('evt_' + randomUUID(), 'refund.failed', { ...refund }));
  const sent = (await pool.query(`SELECT userid,kind FROM app_notification_outbox
    WHERE dedupe_key=$1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3 ORDER BY id`,
    [`equipment-receipt:${assisted.id}`, `equipment-refund:${assisted.id}:%`, `equipment-refund-failed:${assisted.id}:%`])).rows;
  assert.deepEqual(sent, [{ userid: staff, kind: 'payment_receipt' }, { userid: staff, kind: 'payment_refunded' },
    { userid: staff, kind: 'payment_status_changed' }]);
});

test('only administrators refund a staff account\'s payments, so staff cannot refund their own', async () => {
  const own = await booking(true, staff), pass = await cardPass(staff), adminPass = await cardPass(admin);
  const colleague = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status,primary_role)
    VALUES('Refund','Colleague','refund-colleague@example.invalid','unused','0000000000','active','staff') RETURNING userid`)).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'", [colleague]);
  const billing = randomUUID(), invoice = 'in_staff_' + randomBytes(4).toString('hex');
  await pool.query(`INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status) VALUES($1,$2,1,'{}',5000,'active')`, [billing, staff]);
  const payment = await new StaffModel(pool).createPayment(staff, staffMembership, '50.00', 'paid', 'card', invoice, 'Stripe test recurring membership', staff);
  await pool.query(`INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end,payment_intent)
    VALUES($1,$2,$3,$4,now(),now()+interval '1 month','pi_'||$1)`, [invoice, billing, staffMembership, payment]);
  const intents = [own.intent, pass.intent, adminPass.intent, 'pi_' + invoice];

  // A refund leaves the booking, the day pass's use and the paid period in place, so it would be free use.
  await assert.rejects(equipmentBilling.refund(staff, own.id, 'Refunding my own booking'), { code: 'SELF_CHANGE_FORBIDDEN' });
  await assert.rejects(passes.staffRefund(staff, pass.id, 'Refunding my own pass'), { code: 'SELF_CHANGE_FORBIDDEN' });
  await assert.rejects(memberships.refund(staff, invoice, 'Refunding my own membership'), { code: 'SELF_CHANGE_FORBIDDEN' });
  // Another staff member can't refund them either, and an administrator can't refund their own.
  await assert.rejects(equipmentBilling.refund(colleague, own.id, 'Refunding a colleague'), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(passes.staffRefund(colleague, pass.id, 'Refunding a colleague'), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(memberships.refund(colleague, invoice, 'Refunding a colleague'), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(passes.staffRefund(admin, adminPass.id, 'Refunding my own pass'), { code: 'SELF_CHANGE_FORBIDDEN' });
  assert.equal(refunds.filter(f => intents.includes(f.payment_intent as string)).length, 0, 'nothing was refunded');
  assert.deepEqual(await own.state(), { refund_id: null, refund_status: null, payment: 'paid' });

  nextStatus = 'succeeded';
  assert.deepEqual(await equipmentBilling.refund(admin, own.id, 'Approved by an administrator'), { status: 'succeeded' });
  assert.deepEqual(await passes.staffRefund(admin, pass.id, 'Approved by an administrator'), { status: 'succeeded' });
  assert.deepEqual(await memberships.refund(admin, invoice, 'Approved by an administrator'), { status: 'succeeded' });
  assert.equal(refunds.filter(f => intents.includes(f.payment_intent as string)).length, 3);
});

test('a refund made in Stripe before the app recorded the payment is applied once the payment is', async () => {
  const held = await booking(false);
  const refund: Refund = { id: 're_early_' + randomBytes(3).toString('hex'), object: 'refund', status: 'succeeded', amount: 700,
    currency: 'usd', payment_intent: held.intent, metadata: {} };
  refunds.unshift(refund);
  // The booking was paid and then refunded in the Stripe dashboard while it waited, for example on a missing waiver.
  await equipmentBilling.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', { ...refund }));
  assert.deepEqual(await held.state(), { refund_id: null, refund_status: null, payment: 'pending' }, 'no recorded payment to match yet');

  Object.assign(held.session, { status: 'complete', payment_status: 'paid', payment_intent: held.intent });
  await equipmentBilling.apply(held.session as Stripe.Checkout.Session);
  assert.equal((await new ReservationModel(pool).find(held.id))!.status, 'confirmed');
  assert.deepEqual(await held.state(), { refund_id: refund.id, refund_status: 'succeeded', payment: 'refunded' });
  assert.deepEqual((await notices(`equipment-refund:${held.id}:%`)).map(n => [n.userid, n.kind]), [[member, 'payment_refunded']]);
});

test('a failed staff refund of a pass past its cancel-by date is not the member\'s to retry, and their pass list says so', async () => {
  const { id } = await cardPass(member);
  nextStatus = 'failed';
  assert.deepEqual(await passes.staffRefund(staff, id, 'Visit cut short'), { status: 'failed' });
  // Staff refunds don't record a member cancellation, which is what lets a member retry after the deadline.
  const listed = (await passes.mine(member)).find(p => p.id === id)!;
  assert.deepEqual([listed.status, listed.refundStatus, listed.cancelRequested, listed.passIssued], ['paid', 'failed', false, true]);
  await assert.rejects(passes.cancel(member, id), { code: 'CANCELLATION_NOTICE' });
  nextStatus = 'succeeded';
});
