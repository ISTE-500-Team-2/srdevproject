import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, mock, test } from 'node:test';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { PassBilling } from '../../src/billing/passes.js';
import { BillingPricing } from '../../src/billing/pricing.js';
import { businessToday } from '../../src/businessDate.js';
import { StaffModel } from '../../src/models/StaffModel.js';
import { StaffService } from '../../src/services/StaffService.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { stripeEvent, stripeMock, type StripeFixture } from '../helpers/stripeFixtures.js';

type Session = StripeFixture<Stripe.Checkout.Session>;
type Refund = StripeFixture<Stripe.Refund>;
const zone = 'America/New_York';
const database = 'arbor_pass_unissued_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const provider = new StudioStripe({ key: 'sk_test_fixture', webhookSecret: 'whsec_fixture', origin: 'http://localhost' });
const passes = new PassBilling(pool, provider, zone), pricing = new BillingPricing(pool), staff = new StaffService(pool, zone);
const stripe = stripeMock(provider);
let created = false, member: number, admin: number, dayPlan: number;

// A small Stripe stand-in: sessions by id, refunds per payment intent (newest first), idempotent creates.
const sessions = new Map<string, Session>();
let sessionParams: Stripe.Checkout.SessionCreateParams[] = [];
let refunds: Refund[] = [], refundKeys: string[] = [], nextRefund: Stripe.Refund['status'] = 'succeeded';
let lostRefundResponse = false;
const byKey = new Map<string, Refund>();
stripe.checkoutSessionCreate(async params => {
  sessionParams.push(params!);
  const session: Session = { id: 'cs_' + randomBytes(5).toString('hex'), object: 'checkout.session', livemode: false, mode: 'payment',
    status: 'open', url: 'https://checkout.stripe.com/test', client_reference_id: params!.client_reference_id, metadata: params!.metadata as Record<string, string>,
    amount_total: params!.line_items![0]!.price_data!.unit_amount!, currency: 'usd' };
  sessions.set(session.id!, session);
  return session;
});
stripe.checkoutSessionRetrieve(async id => sessions.get(id)!);
stripe.checkoutSessionList(async () => ({ data: [...sessions.values()], has_more: false }));
const listRefunds = async (params?: Stripe.RefundListParams) =>
  ({ data: refunds.filter(f => f.payment_intent === params?.payment_intent), has_more: false });
stripe.refundList(listRefunds);
stripe.refundRetrieve(async id => refunds.find(f => f.id === id)!);
stripe.refundCreate(async (params, options) => {
  const key = options!.idempotencyKey!;
  refundKeys.push(key);
  if (byKey.has(key)) return byKey.get(key)!;
  const refund: Refund = { id: 're_' + randomBytes(4).toString('hex'), object: 'refund', status: nextRefund, amount: params!.amount!, currency: 'usd',
    payment_intent: params!.payment_intent as string, metadata: params!.metadata as Record<string, string> ?? {} };
  refunds.unshift(refund); byKey.set(key, refund);
  if (lostRefundResponse) throw new Error('Stripe refund response lost');
  return refund;
});

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  admin = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  dayPlan = (await pool.query("SELECT tierid FROM membership_tiers WHERE kind='day_pass' AND active LIMIT 1")).rows[0].tierid;
  await pool.query('UPDATE membership_tiers SET tierprice=15 WHERE tierid=$1', [dayPlan]);
  await pool.query(`INSERT INTO user_waiver(userid,waiverid,approval,signdate) SELECT $1,waiverid,true,now() FROM waiver WHERE isactive=true AND required=true`, [member]);
});
beforeEach(() => { sessionParams = []; refundKeys = []; nextRefund = 'succeeded'; });
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

async function input(date: string) {
  const offer = (await pricing.offers(member, date)).find(p => p.id === dayPlan)!;
  return { planId: dayPlan, expectedRevision: offer.revision, pricingRevision: offer.pricingRevision, amountCents: offer.amountCents, validDate: date };
}
const desk = (date: string) => ({ requestId: randomUUID(), planId: dayPlan, startsAt: null, validDate: date,
  paymentStatus: 'paid' as const, method: 'cash', reference: 'DESK', reason: 'Paid cash at the desk' });
const checkoutRow = async (date: string) =>
  (await pool.query('SELECT * FROM app_pass_checkout WHERE userid=$1 AND valid_date=$2::date ORDER BY created_at DESC LIMIT 1', [member, date])).rows[0];
/** A pending online checkout with an open Stripe session, as if the member had left a checkout tab open. */
async function openCheckout(date: string) {
  const id = randomUUID(), session: Session = { id: 'cs_' + randomBytes(5).toString('hex'), object: 'checkout.session', livemode: false, mode: 'payment',
    status: 'open', client_reference_id: id, metadata: { dayPassCheckoutId: id }, amount_total: 1500, currency: 'usd' };
  sessions.set(session.id!, session);
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,checkout_id)
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername),1500,$4 FROM membership_tiers WHERE tierid=$5`, [id, member, date, session.id, dayPlan]);
  return { id, session };
}
/** The member pays in that tab and Stripe reports it. */
async function pay(session: Session) {
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomBytes(5).toString('hex') });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', { ...session });
  await passes.webhook(event);
  return event;
}
const notice = async (key: string) =>
  (await pool.query('SELECT kind,payload FROM app_notification_outbox WHERE dedupe_key=$1', [key])).rows[0];
const passCount = async (date: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM day_pass WHERE userid=$1 AND validdate::date=$2::date AND status='active'`, [member, date])).rows[0].n;

test('desk issuance waits while the member has an open online checkout for that date', async () => {
  const date = '2034-04-10';
  await passes.checkout(member, await input(date));
  assert.ok((await checkoutRow(date)).checkout_id, 'the checkout has a Stripe session');
  // Staff can clear it themselves from the member's account, so the refusal says how.
  await assert.rejects(staff.issue(admin, member, desk(date)), { code: 'CHECKOUT_OPEN', message: /View as.*Cancel checkout/ });
  assert.equal(await passCount(date), 0);
  // Once the session can no longer take payment, the desk can issue the pass.
  await pool.query("UPDATE app_pass_checkout SET checkout_expires_at=now()-interval '1 minute' WHERE userid=$1 AND valid_date=$2", [member, date]);
  await staff.issue(admin, member, desk(date));
  assert.equal(await passCount(date), 1);

  // A checkout that never got a session can't be paid, so it doesn't block the desk either.
  const other = '2034-04-11', id = randomUUID();
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents) VALUES($1,$2,$3,$4,'{}',1500)`, [id, member, dayPlan, other]);
  await staff.issue(admin, member, desk(other));
  assert.equal(await passCount(other), 1);
});

test('a card payment that arrives after a desk pass for the same date is recorded and refunded, not lost', async () => {
  const date = '2034-05-10';
  await staff.issue(admin, member, desk(date));
  // The online checkout was opened before the desk pass (or raced it) and the member pays anyway.
  const { id, session } = await openCheckout(date);
  const event = await pay(session);
  assert.ok((await pool.query('SELECT id FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 'the event is acknowledged, so Stripe stops retrying');
  assert.equal(await passCount(date), 1, 'no second pass');

  const row = (await pool.query('SELECT * FROM app_pass_checkout WHERE id=$1', [id])).rows[0];
  assert.equal(row.pass_id, null);
  assert.ok(row.payment_id, 'the card charge is recorded');
  assert.equal(row.payment_intent, session.payment_intent);
  assert.deepEqual([row.status, row.refund_status], ['cancelled', 'succeeded']);
  assert.deepEqual(refundKeys, [`daypass-refund:${id}`]);
  assert.equal(refunds[0]!.amount, 1500);
  const payment = (await pool.query('SELECT method,price::text,paymentstatus FROM payment WHERE paymentid=$1', [row.payment_id])).rows[0];
  assert.deepEqual(payment, { method: 'card', price: '15.00', paymentstatus: 'refunded' });
  assert.match((await notice('daypass-not-issued:' + id)).payload.instructions, /already had a day pass for this date.*refunding it to your original card/);
  assert.ok(await notice(`daypass-refund:${id}:${refunds[0]!.id}`), 'the refund confirmation is sent');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_staff_audit WHERE action='daypass.not_issued' AND entity_id=$1", [row.payment_id])).rows[0].n, 1);
  // Payment history names what the charge was for.
  const listed = (await new StaffModel(pool).payments(member)).find(p => p.id === row.payment_id)!;
  assert.equal(listed.planName, (await pool.query('SELECT tiername FROM membership_tiers WHERE tierid=$1', [dayPlan])).rows[0].tiername);

  // Another delivery for the same session changes nothing.
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', { ...session }));
  assert.equal(await passCount(date), 1);
  assert.equal(refundKeys.length, 1, 'no second refund request');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment WHERE reference=$1', [session.id])).rows[0].n, 1);
});

test('a payment first reported after the visit date ended requires staff review', async () => {
  const yesterday = (await pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date-1,'YYYY-MM-DD') AS d`, [zone])).rows[0]!.d;
  const { id, session } = await openCheckout(yesterday);
  await pay(session);
  assert.equal(await passCount(yesterday), 0);
  const row = await checkoutRow(yesterday);
  assert.ok(row.payment_id);
  assert.equal(row.refund_needs_review, true);
  assert.equal(refundKeys.length, 0);
  const listed = (await passes.mine(member)).find(p => p.id === id)!;
  assert.deepEqual([listed.refundStatus, listed.passIssued, listed.cancelRequested], ['needs_review', false, false]);
  await assert.rejects(passes.cancel(member, id), { code: 'RECONCILE_REQUIRED' });
  assert.deepEqual(await passes.staffRefund(admin, id, 'Shift log confirms no admission', true), { status: 'reviewed' });
  assert.equal(refundKeys.length, 0);
  assert.deepEqual(await passes.staffRefund(admin, id, 'Refund unused visit'), { status: 'succeeded' });
});

test('a captured visit queued through local midnight is held for staff who may have admitted the member', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2034-05-16T03:50:00Z') });
  const date = businessToday(zone);
  const { id, session } = await openCheckout(date);
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomUUID() });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session);
  stripe.refundList(async () => { throw new Error('Stripe refund lookup unavailable'); });
  try {
    await assert.rejects(passes.webhook(event), /refund lookup unavailable/);
  } finally {
    stripe.refundList(listRefunds);
  }
  const captured = await checkoutRow(date);
  assert.ok(captured.payment_id);
  assert.ok(captured.refund_reconcile_after);
  // Staff recorded admission separately during rollback. Only the checkout survives here.
  t.mock.timers.setTime(Date.parse('2034-05-16T04:01:00Z'));
  await passes.reconcileRefunds();
  await passes.webhook(event);
  const held = await checkoutRow(date);
  assert.deepEqual([held.payment_id, held.pass_id, held.refund_needs_review, held.refund_reconcile_after],
    [captured.payment_id, null, true, null]);
  await assert.rejects(passes.staffRefund(admin, id, 'Attempt without review'), { code: 'RECONCILE_REQUIRED' });
  assert.deepEqual(await passes.staffRefund(admin, id, 'Shift log confirms admission', true), { status: 'reviewed' });
  await passes.reconcileRefunds();
  assert.equal((await checkoutRow(date)).refund_needs_review, false);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [held.payment_id])).rows[0].paymentstatus, 'paid');
  assert.equal(refundKeys.length, 0);
});

test('a lost automatic refund response leaves the captured charge recorded and the webhook retry reconciles it', async () => {
  const date = '2034-05-11';
  await staff.issue(admin, member, desk(date));
  const { id, session } = await openCheckout(date);
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomUUID() });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', { ...session });

  lostRefundResponse = true;
  try {
    await assert.rejects(passes.webhook(event), /Stripe refund response lost/);
  } finally {
    lostRefundResponse = false;
  }
  assert.equal((await pool.query('SELECT id FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 1);
  const captured = await checkoutRow(date);
  assert.equal(captured.id, id);
  assert.equal(captured.status, 'paid');
  assert.equal(captured.pass_id, null);
  assert.equal(captured.payment_intent, session.payment_intent);
  assert.ok(captured.cancel_requested_at, 'refund intent is durable');
  assert.ok(captured.payment_id, 'the captured charge is visible in Payments');
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [captured.payment_id])).rows[0].paymentstatus, 'paid');

  await passes.webhook(event);
  await passes.webhook(event);
  const reconciled = await checkoutRow(date);
  assert.equal(reconciled.payment_id, captured.payment_id);
  assert.deepEqual([reconciled.status, reconciled.refund_status], ['cancelled', 'succeeded']);
  assert.deepEqual(refundKeys, [`daypass-refund:${id}`]);
  assert.equal(await passCount(date), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment WHERE reference=$1', [session.id])).rows[0].n, 1);
});

test('the reconciliation tick submits a missed automatic refund and backs off failures', async () => {
  const date = '2034-05-12';
  await staff.issue(admin, member, desk(date));
  const { id, session } = await openCheckout(date);
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomUUID() });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', { ...session });

  const error = mock.method(console, 'error', () => {});
  stripe.refundList(async () => { throw new Error('Stripe is unavailable'); });
  try {
    await assert.rejects(passes.webhook(event), /Stripe is unavailable/);
    assert.equal((await checkoutRow(date)).refund_id, null);
    assert.equal(refundKeys.length, 0, 'the automatic refund was never submitted');
    await passes.reconcileRefunds();
    assert.equal(error.mock.callCount(), 1);
    await passes.reconcileRefunds();
    assert.equal(error.mock.callCount(), 1, 'a failed lookup waits before being retried');

    stripe.refundList(listRefunds);
    await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now()-interval '1 second' WHERE id=$1", [id]);
    await Promise.all([passes.reconcileRefunds(), passes.reconcileRefunds()]);
    const row = await checkoutRow(date);
    assert.deepEqual([row.status, row.refund_id, row.refund_status, row.refund_reconcile_after], ['cancelled', refunds[0]!.id, 'succeeded', null]);
    assert.deepEqual(refundKeys, [`daypass-refund:${id}`], 'the sweep submits the refund once');
    assert.equal(await passCount(date), 1);
  } finally {
    stripe.refundList(listRefunds);
    error.mock.restore();
  }
});

test('a paid checkout grants no pass while the initial refund lookup is unavailable', async () => {
  const date = '2034-05-14';
  const { id, session } = await openCheckout(date);
  const intent = 'pi_' + randomUUID();
  const refund: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd', payment_intent: intent };
  refunds.unshift(refund);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', refund));
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session);

  stripe.refundList(async () => {
    assert.equal(await passCount(date), 0, 'also inactive while contacting Stripe');
    throw new Error('Stripe is unavailable');
  });
  try {
    await assert.rejects(passes.webhook(event), /Stripe is unavailable/);
  } finally {
    stripe.refundList(listRefunds);
  }
  const captured = await checkoutRow(date);
  assert.equal(await passCount(date), 0);
  assert.ok(captured.payment_id);
  assert.ok(captured.refund_reconcile_after);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [captured.payment_id])).rows[0].paymentstatus, 'paid');
  assert.equal(await notice('daypass-receipt:' + id), undefined);

  await passes.reconcileRefunds();
  const reconciled = await checkoutRow(date);
  assert.equal(reconciled.payment_id, captured.payment_id);
  assert.deepEqual([reconciled.status, reconciled.refund_id, reconciled.refund_reconcile_after], ['cancelled', refund.id, null]);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [captured.payment_id])).rows[0].paymentstatus, 'refunded');
  assert.equal(await passCount(date), 0);
  assert.equal(refundKeys.length, 0);
});

test('an early partial Stripe refund holds access and records the captured payment and checkout event', async () => {
  const date = '2034-05-13';
  const { id, session } = await openCheckout(date);
  const intent = 'pi_' + randomUUID();
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
  const refund: Refund = { id: 're_' + randomUUID(), object: 'refund', status: 'succeeded', amount: 500, currency: 'usd', payment_intent: intent };
  refunds.unshift(refund);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', refund));
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session);
  const error = mock.method(console, 'error', () => {});
  try {
    await passes.webhook(event);
    await passes.webhook(event);
    assert.deepEqual(error.mock.calls.map(call => call.arguments[1].code), ['RECONCILE_REQUIRED']);
  } finally {
    error.mock.restore();
  }
  const row = await checkoutRow(date);
  assert.equal(row.id, id);
  assert.equal(row.pass_id, null);
  assert.equal(await passCount(date), 0);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === row.payment_id)?.refundStatus, 'needs_review');
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [row.payment_id])).rows[0].paymentstatus, 'paid');
  assert.equal((await pool.query('SELECT id FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 1);
  assert.equal(refundKeys.length, 0);
});

test('staff can honor a held visit after verifying a settled partial refund', async t => {
  const date = '2034-05-16';
  const { id, session } = await openCheckout(date);
  const intent = 'pi_' + randomUUID(), charge = 'ch_' + randomUUID();
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
  const refund = { id: 're_' + randomUUID(), status: 'succeeded' as const, amount: 500, currency: 'usd', payment_intent: intent, charge };
  refunds.unshift(refund);
  let captured = false;
  const retrieve = provider.sdk.paymentIntents.retrieve;
  t.after(() => { provider.sdk.paymentIntents.retrieve = retrieve; });
  stripe.paymentIntentRetrieve(async (id, params) => {
    assert.equal(id, intent);
    assert.deepEqual(params?.expand, ['latest_charge']);
    return { id, livemode: false, status: 'succeeded', latest_charge: {
      id: charge, payment_intent: intent, livemode: false, paid: true, status: 'succeeded',
      captured, amount_captured: captured ? 1500 : 0, currency: 'usd',
    } };
  });
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session));
  const held = await checkoutRow(date);
  assert.equal(held.refund_needs_review, true);
  assert.equal(await passCount(date), 0);

  await assert.rejects(staff.issue(admin, member, desk(date)), { code: 'CHECKOUT_OPEN', message: /already paid by card.*Review refund/ });
  // Keep the old review action safe by default, and refuse if Stripe cannot verify capture.
  await assert.rejects(passes.staffRefund(admin, id, 'Check the partial refund', true), { code: 'RECONCILE_REQUIRED' });
  const honorVisit = () => passes.staffRefund(admin, id, 'Honor the visit', true, true);
  await assert.rejects(async () => honorVisit(), { code: 'RECONCILE_REQUIRED' });
  assert.equal(await passCount(date), 0);
  captured = true;
  assert.deepEqual(await honorVisit(), { status: 'reviewed' });
  assert.deepEqual(await honorVisit(), { status: 'reviewed' });
  const issued = await checkoutRow(date);
  assert.equal(issued.payment_id, held.payment_id);
  assert.equal(issued.refund_needs_review, false);
  assert.equal(issued.refund_status, 'partial');
  assert.equal(await passCount(date), 1);
  const ledger = (await pool.query('SELECT price::text,paymentstatus FROM payment WHERE paymentid=$1', [held.payment_id])).rows[0];
  assert.deepEqual(ledger, { price: '15.00', paymentstatus: 'paid' });
  const audit = (await pool.query("SELECT after_state FROM app_staff_audit WHERE action='billing.refund.reviewed' AND entity_id=$1", [held.payment_id])).rows[0];
  assert.deepEqual(audit.after_state, { checkoutId: id, refundIds: [refund.id], refundedCents: 500, retainedCents: 1000 });
  assert.equal(refundKeys.length, 0);

  refunds.unshift({ ...refund, id: 're_' + randomUUID(), amount: 1000 });
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', refunds[0]!));
  assert.equal(await passCount(date), 0, 'refunds covering the full amount cancel access');
  assert.equal((await checkoutRow(date)).refund_status, 'succeeded');
});

test('card checkout expires at local midnight even when fewer than 45 minutes remain', async t => {
  const now = new Date('2034-06-10T03:20:00Z'); // 11:20 p.m. on June 9 in New York.
  t.mock.timers.enable({ apis: ['Date'], now });
  await passes.checkout(member, await input('2034-06-09'));
  assert.equal(sessionParams.at(-1)!.expires_at, Date.parse('2034-06-10T04:00:00Z') / 1000);

  // A future visit gives the largest window the app allows before reconciliation.
  await passes.checkout(member, await input('2034-06-10'));
  assert.equal(sessionParams.at(-1)!.expires_at, now.getTime() / 1000 + 23 * 3600);
});

test('card checkout refuses to start when fewer than 30 minutes remain', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2034-06-12T03:31:00Z') });
  const date = businessToday(zone);
  await assert.rejects(passes.checkout(member, await input(date)), {
    code: 'CHECKOUT_TOO_LATE', message: /closes 30 minutes before the visit date ends/,
  });
  assert.equal(sessionParams.length, 0);
  assert.equal(await checkoutRow(date), undefined);
});

test('Stripe rejecting the pinned same-day expiry returns the checkout cutoff message', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2034-06-13T03:29:59Z') });
  const create = provider.sdk.checkout.sessions.create;
  t.after(() => { provider.sdk.checkout.sessions.create = create; });
  stripe.checkoutSessionCreate(async params => {
    assert.equal(params?.expires_at, Date.parse('2034-06-13T04:00:00Z') / 1000);
    t.mock.timers.tick(2000);
    throw new Stripe.errors.StripeInvalidRequestError({ param: 'expires_at', message: 'Checkout must expire at least 30 minutes from now' });
  });
  await assert.rejects(passes.checkout(member, await input(businessToday(zone))), {
    code: 'CHECKOUT_TOO_LATE', message: /closes 30 minutes before the visit date ends/,
  });
});

test('a same-day legacy checkout with no Stripe session can be replaced or cancelled immediately', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2034-07-16T15:00:00Z') });
  for (const action of ['replace', 'cancel'] as const) {
    const date = businessToday(zone), body = await input(date), id = randomUUID();
    await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,created_at)
      VALUES($1,$2,$3,$4,'{}',$5,$6)`, [id, member, dayPlan, date, body.amountCents, new Date()]);
    if (action === 'replace') {
      assert.ok((await passes.checkout(member, body)).checkoutUrl);
      assert.notEqual(sessionParams.at(-1)!.metadata?.dayPassCheckoutId, id);
    } else {
      assert.deepEqual(await passes.cancel(member, id), { cancelled: true });
    }
    assert.equal((await pool.query('SELECT status FROM app_pass_checkout WHERE id=$1', [id])).rows[0].status, 'expired');
    t.mock.timers.tick(24 * 3600000);
  }
  assert.equal(sessionParams.length, 1);

  // A create started before the visit date can still be in flight when
  // today's session lookup finds nothing and the member clears the row.
  const date = '2034-07-19', body = await input(date), id = randomUUID();
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,created_at)
    VALUES($1,$2,$3,$4,'{}',$5,$6)`, [id, member, dayPlan, date, body.amountCents, new Date()]);
  const create = provider.sdk.checkout.sessions.create;
  t.after(() => { provider.sdk.checkout.sessions.create = create; });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  stripe.checkoutSessionCreate(async () => {
    entered();
    await released;
    return { id: 'cs_late_legacy', status: 'open', url: 'https://checkout.stripe.com/late' };
  });
  const stale = assert.rejects(passes.checkout(member, body), { code: 'PAYMENT_PROCESSING' });
  await started;
  t.mock.timers.tick(24 * 3600000);
  try {
    assert.deepEqual(await passes.cancel(member, id), { cancelled: true });
  } finally {
    finish();
    await stale;
  }
});

test('a payment on an old-release URL reconciles while its replacement is still open', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2034-07-20T03:50:00Z') });
  const date = '2034-07-20', id = randomUUID();
  const body = await input(date);
  // The old release selected this row and started creating a session just before midnight.
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,created_at)
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername,'id',tierid),$4,$6 FROM membership_tiers WHERE tierid=$5`,
    [id, member, date, body.amountCents, dayPlan, new Date()]);
  t.mock.timers.tick(20 * 60 * 1000);
  assert.ok((await passes.checkout(member, body)).checkoutUrl);
  const replacement = await checkoutRow(date);
  assert.notEqual(replacement.id, id);

  // c95a2b57 binds by id and NULL checkout_id only, then returns the open session URL.
  const old: Session = { ...sessions.get(replacement.checkout_id), id: 'cs_old_' + id, client_reference_id: id,
    metadata: { dayPassCheckoutId: id } };
  sessions.set(old.id!, old);
  const bound = await pool.query('UPDATE app_pass_checkout SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL', [id, old.id]);
  assert.equal(bound.rowCount, 1);
  const read = async (checkoutId: string) =>
    (await pool.query('SELECT * FROM app_pass_checkout WHERE id=$1', [checkoutId])).rows[0];
  assert.equal((await read(id)).status, 'expired');
  assert.equal((await read(replacement.id)).status, 'pending');

  const event = await pay(old);
  await passes.webhook(event);
  const accepted = await read(id);
  assert.equal(accepted.status, 'paid');
  assert.ok(accepted.payment_id);
  assert.ok(accepted.pass_id);
  assert.equal((await read(replacement.id)).status, 'expired');
  assert.equal(await passCount(date), 1);
  assert.equal(refundKeys.length, 0);

  // A member who already opened the replacement can still pay before Stripe closes that page.
  const duplicateSession = sessions.get(replacement.checkout_id)!;
  Object.assign(duplicateSession, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomUUID() });
  const duplicateEvent = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', duplicateSession);
  stripe.refundList(async () => { throw new Error('Stripe refund lookup unavailable'); });
  try {
    await assert.rejects(passes.webhook(duplicateEvent), /Stripe refund lookup unavailable/);
  } finally {
    stripe.refundList(listRefunds);
  }
  const capturedDuplicate = await read(replacement.id);
  assert.ok(capturedDuplicate.payment_id, 'a Stripe outage does not lose the second captured charge');
  assert.ok(capturedDuplicate.refund_reconcile_after);
  await passes.reconcileRefunds();
  await passes.webhook(duplicateEvent);
  const duplicate = await read(replacement.id);
  assert.equal(duplicate.payment_id, capturedDuplicate.payment_id);
  assert.equal(duplicate.status, 'cancelled');
  assert.equal(duplicate.refund_status, 'succeeded');
  assert.ok(duplicate.payment_id && duplicate.payment_id !== accepted.payment_id);
  assert.equal(duplicate.pass_id, null);
  assert.equal(await passCount(date), 1);
  assert.deepEqual(refundKeys, ['daypass-refund:' + replacement.id]);
});

test('a retry too close to its expiry recovers a session instead of opening another one', async () => {
  const date = '2034-07-10', body = await input(date);
  await passes.checkout(member, body);
  const row = await checkoutRow(date);
  await pool.query("UPDATE app_pass_checkout SET checkout_id=NULL,checkout_expires_at=now()+interval '15 minutes' WHERE id=$1", [row.id]);
  assert.ok((await passes.checkout(member, body)).checkoutUrl);
  assert.equal(sessionParams.length, 1);
  assert.equal((await checkoutRow(date)).checkout_id, row.checkout_id);
});

test('a legacy checkout whose Stripe response was lost retries with the original parameters and key', async () => {
  const date = '2034-07-11', body = await input(date), id = randomUUID();
  const row = (await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,created_at)
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername),$4,now()-interval '22 hours' FROM membership_tiers WHERE tierid=$5
    RETURNING (SELECT email FROM "user" WHERE userid=$2),plan_snapshot`, [id, member, date, body.amountCents, dayPlan])).rows[0];
  const original = {
    mode: 'payment', payment_method_types: ['card'], client_reference_id: id, customer_email: row.email,
    metadata: { dayPassCheckoutId: id },
    success_url: `http://localhost/checkout-return?member=${member}&pass=returned`,
    cancel_url: `http://localhost/checkout-return?member=${member}&pass=cancelled`,
    payment_intent_data: { metadata: { dayPassCheckoutId: id } },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: body.amountCents, product_data: { name: row.plan_snapshot.name } } }],
  };
  const accepted = { id: 'cs_legacy_' + id, livemode: false, status: 'open', url: 'https://checkout.stripe.com/legacy' } as const;
  const create = provider.sdk.checkout.sessions.create;
  stripe.checkoutSessionCreate(async (params, options) => {
    assert.deepEqual(params, original, 'Stripe requires an identical retry for the existing key');
    assert.equal(options?.idempotencyKey, 'daypass-checkout:' + id);
    return accepted;
  });
  try {
    assert.deepEqual(await passes.checkout(member, body), { checkoutUrl: accepted.url });
    assert.equal((await checkoutRow(date)).checkout_id, accepted.id);
  } finally {
    provider.sdk.checkout.sessions.create = create;
  }
});

test('a changed email recovers a legacy session using the original checkout identity', async t => {
  const date = '2034-07-12', body = await input(date), id = randomUUID();
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents)
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername),$4 FROM membership_tiers WHERE tierid=$5`,
    [id, member, date, body.amountCents, dayPlan]);
  const accepted: Session = { id: 'cs_legacy_' + id, livemode: false, status: 'open', url: 'https://checkout.stripe.com/legacy',
    mode: 'payment', client_reference_id: id, metadata: { dayPassCheckoutId: id }, currency: 'usd', amount_total: body.amountCents };
  const create = provider.sdk.checkout.sessions.create, list = provider.sdk.checkout.sessions.list;
  sessions.set(accepted.id!, accepted);
  t.after(() => {
    provider.sdk.checkout.sessions.create = create;
    provider.sdk.checkout.sessions.list = list;
  });
  await pool.query('UPDATE "user" SET email=$2 WHERE userid=$1', [member, 'changed@collaboratory.invalid']);
  stripe.checkoutSessionCreate(async (params, options) => {
    assert.equal(params?.customer_email, 'changed@collaboratory.invalid');
    assert.equal(options?.idempotencyKey, 'daypass-checkout:' + id);
    throw new Stripe.errors.StripeIdempotencyError({ message: 'Parameters differ from the original request' });
  });
  stripe.checkoutSessionList(async params => params?.starting_after === 'cs_unrelated'
    ? { data: [accepted], has_more: false }
    : { data: [{ ...accepted, id: 'cs_unrelated', metadata: {} }], has_more: true });
  assert.deepEqual(await passes.checkout(member, body), { checkoutUrl: accepted.url });
  assert.equal((await checkoutRow(date)).checkout_id, accepted.id);
  assert.deepEqual(await passes.checkout(member, body), { checkoutUrl: accepted.url });
});

test('the rollback query identifies a captured day-pass charge when replay is ignored by the previous webhook', async t => {
  const date = '2034-07-13';
  const { id, session } = await openCheckout(date);
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomUUID() });
  const event = stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session);
  stripe.refundList(async () => { throw new Error('Stripe refund lookup unavailable'); });
  t.after(() => stripe.refundList(listRefunds));
  await assert.rejects(passes.webhook(event), /refund lookup unavailable/);
  // The previous release returns as soon as this insert conflicts.
  const replay = await pool.query('INSERT INTO app_pass_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [event.id]);
  assert.equal(replay.rowCount, 0);
  const sql = await readFile(new URL('../../../database/fixes/list-day-pass-rollback-payments.sql', import.meta.url), 'utf8');
  const queued = (await pool.query(sql)).rows.find(row => row.checkout_id === id);
  assert.equal(queued?.stripe_payment_intent, session.payment_intent);
  assert.equal(queued?.ledger_status, 'paid');
  assert.equal(queued?.pass_id, null);
  assert.ok(queued?.refund_reconcile_after);
  assert.equal(await passCount(date), 0);

  // The compatible worker can resume the payment with the same payment ID and no new charge.
  stripe.refundList(listRefunds);
  await passes.webhook(event);
  assert.equal((await checkoutRow(date)).payment_id, queued.payment_id);
  assert.equal(await passCount(date), 1);
  assert.ok(!(await pool.query(sql)).rows.some(row => row.checkout_id === id));
});

test('successful Stripe partial refunds covering the full charge cancel the checkout before issuance', async () => {
  const date = '2034-07-14';
  const { session } = await openCheckout(date);
  const intent = 'pi_' + randomUUID();
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
  refunds.unshift(...[500, 1000].map(amount => ({ id: 're_' + randomUUID(), status: 'succeeded' as const, amount, currency: 'usd', payment_intent: intent })));
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session));
  const row = await checkoutRow(date);
  assert.deepEqual([row.status, row.refund_status, row.refund_reconcile_after], ['cancelled', 'succeeded', null]);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [row.payment_id])).rows[0].paymentstatus, 'refunded');
  assert.equal(await passCount(date), 0);
  assert.equal(refundKeys.length, 0);
});

test('staff review releases a held checkout once all the partial refunds have failed', async () => {
  const date = '2034-07-15';
  const { session } = await openCheckout(date);
  const intent = 'pi_' + randomUUID();
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: intent });
  const settled: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 500, currency: 'usd', payment_intent: intent };
  const inFlight: Refund = { id: 're_' + randomUUID(), status: 'pending', amount: 1000, currency: 'usd', payment_intent: intent };
  refunds.unshift(settled, inFlight);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session));
  const held = await checkoutRow(date);
  assert.equal(held.refund_needs_review, true);
  assert.equal(held.status, 'pending');
  assert.equal(await passCount(date), 0);

  inFlight.status = 'failed';
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.failed', inFlight));
  await passes.reconcileRefunds();
  assert.equal((await checkoutRow(date)).refund_needs_review, true);
  assert.equal(await passCount(date), 0);
  await assert.rejects(passes.staffRefund(admin, held.id, 'Check open partial refund', true), { code: 'RECONCILE_REQUIRED' });
  settled.status = 'failed';
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.failed', settled));
  assert.deepEqual(await passes.staffRefund(admin, held.id, 'Both partial refunds failed', true), { status: 'reviewed' });
  const issued = await checkoutRow(date);
  assert.equal(issued.refund_needs_review, false);
  assert.equal(issued.payment_id, held.payment_id);
  assert.equal(issued.status, 'paid');
  assert.equal(await passCount(date), 1);
  assert.equal(refundKeys.length, 0);
});
