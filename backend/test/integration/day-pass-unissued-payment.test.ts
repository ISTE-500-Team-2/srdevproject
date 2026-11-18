import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, mock, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { transaction } from '../../src/db.js';
import { AppError } from '../../src/domain.js';
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
const expireSession = async (id: string) => Object.assign(sessions.get(id)!, { status: 'expired' as const });
stripe.checkoutSessionExpire(expireSession);
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
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername,'id',tierid),1500,$4 FROM membership_tiers WHERE tierid=$5`, [id, member, date, session.id, dayPlan]);
  return { id, session };
}
/** Capture the charge so tests can choose where and when Stripe delivers it. */
function capture(session: Session) {
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomBytes(5).toString('hex') });
  return stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', { ...session });
}
async function pay(session: Session) {
  const event = capture(session);
  await passes.webhook(event);
  return event;
}
// Model c95a2b57 issuing from pass_id and ignoring payment_id. A full refund
// it already recorded is skipped even if that issuance replaced the original ledger link.
async function oldCheckoutDelivery(event: Stripe.Event, session: Session, fullRefund?: Refund) {
  await transaction(pool, async db => {
    if (!(await db.query('INSERT INTO app_pass_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [event.id])).rowCount) return;
    await db.query('SELECT pg_advisory_xact_lock($1,$2)', [7121, member]);
    const id = session.metadata!.dayPassCheckoutId!;
    const row = (await db.query<Parameters<PassBilling['issue']>[1]>('SELECT * FROM app_pass_checkout WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    await db.query('UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3 WHERE id=$1', [id, session.id, session.payment_intent]);
    await passes.issue(db, { ...row, payment_id: null }, session.id!);
    if (fullRefund && (row.refund_id !== fullRefund.id || row.refund_status !== 'succeeded'))
      throw new Error('Expected the old handler to skip an already confirmed refund');
  });
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
  assert.equal(captured.payment_id, null);
  assert.ok(captured.refund_reconcile_after);
  // Staff recorded admission separately during rollback. Only the checkout survives here.
  t.mock.timers.setTime(Date.parse('2034-05-16T04:01:00Z'));
  await passes.reconcileRefunds();
  await passes.webhook(event);
  const held = await checkoutRow(date);
  assert.ok(held.payment_id);
  assert.deepEqual([held.payment_id, held.pass_id, held.refund_needs_review, held.refund_reconcile_after],
    [held.payment_id, null, true, null]);
  await assert.rejects(passes.staffRefund(admin, id, 'Attempt without review'), { code: 'RECONCILE_REQUIRED' });
  assert.deepEqual(await passes.staffRefund(admin, id, 'Shift log confirms admission', true), { status: 'reviewed' });
  await passes.reconcileRefunds();
  const closed = await checkoutRow(date);
  assert.equal(closed.refund_needs_review, false);
  assert.equal(closed.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM day_pass WHERE dayid=$1', [closed.pass_id])).rows[0].status, 'cancelled');
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
  const createRefund = provider.sdk.refunds.create;
  stripe.refundCreate(async () => { throw new Error('Stripe is unavailable'); });
  try {
    await assert.rejects(passes.webhook(event), /Stripe is unavailable/);
    assert.equal((await checkoutRow(date)).refund_id, null);
    assert.equal(refundKeys.length, 0, 'the automatic refund was never submitted');
    await passes.reconcileRefunds();
    assert.equal(error.mock.callCount(), 0, 'the failed webhook already backed off the queued retry');
    await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now() WHERE id=$1", [id]);
    await passes.reconcileRefunds();
    assert.equal(error.mock.callCount(), 1);
    await passes.reconcileRefunds();
    assert.equal(error.mock.callCount(), 1, 'a failed lookup waits before being retried');

    provider.sdk.refunds.create = createRefund;
    await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now()-interval '1 second' WHERE id=$1", [id]);
    await Promise.all([passes.reconcileRefunds(), passes.reconcileRefunds()]);
    const row = await checkoutRow(date);
    assert.deepEqual([row.status, row.refund_id, row.refund_status, row.refund_reconcile_after], ['cancelled', refunds[0]!.id, 'succeeded', null]);
    assert.deepEqual(refundKeys, [`daypass-refund:${id}`], 'the sweep submits the refund once');
    assert.equal(await passCount(date), 1);
  } finally {
    provider.sdk.refunds.create = createRefund;
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
  assert.equal(captured.payment_id, null);
  assert.equal(captured.payment_intent, intent);
  assert.ok(captured.refund_reconcile_after);
  assert.equal(await notice('daypass-receipt:' + id), undefined);

  await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now() WHERE id=$1", [id]);
  await passes.reconcileRefunds();
  const reconciled = await checkoutRow(date);
  assert.ok(reconciled.payment_id);
  assert.deepEqual([reconciled.status, reconciled.refund_id, reconciled.refund_reconcile_after], ['cancelled', refund.id, null]);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [reconciled.payment_id])).rows[0].paymentstatus, 'refunded');
  assert.equal(await passCount(date), 0);
  assert.equal(refundKeys.length, 0);
});

for (const source of ['checkout webhook', 'recovery worker']) {
  test(`a refund delivered after the ${source} lookup snapshot still cancels the pass`, async t => {
    const date = source === 'checkout webhook' ? '2034-08-01' : '2034-08-08';
    const { id, session } = await openCheckout(date);
    const completion = capture(session);
    const intent = session.payment_intent as string;
    let snapshotTaken!: () => void, releaseSnapshot!: () => void;
    const started = new Promise<void>(resolve => { snapshotTaken = resolve; });
    const released = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    let firstLookup = true;
    stripe.refundList(async params => {
      if (params?.payment_intent === intent && firstLookup) {
        firstLookup = false;
        snapshotTaken();
        await released;
      }
      // Model list lag even in the refund webhook. Its individual retrieval is current.
      return { data: [], has_more: false };
    });
    t.after(() => stripe.refundList(listRefunds));

    if (source === 'recovery worker')
      await pool.query(`UPDATE app_pass_checkout SET status='expired',checkout_id=NULL,refund_reconcile_after=now() WHERE id=$1`, [id]);
    const completing = source === 'checkout webhook' ? passes.webhook(completion) : passes.reconcileRefunds();
    await started;
    const refund: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd', payment_intent: intent };
    refunds.unshift(refund);
    const event = stripeEvent('evt_' + randomUUID(), 'refund.created', refund);
    const delivering = passes.webhook(event);
    try {
      // Before the fix the receipt commits here. After the fix the handler waits
      // on the same member lock as issuance.
      let reachedRace = false;
      for (let attempt = 0; attempt < 100 && !reachedRace; attempt++) {
        reachedRace = (await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=7121 AND objid=$1 AND NOT granted
          UNION ALL SELECT 1 FROM app_pass_stripe_event WHERE id=$2`, [member, event.id])).rowCount! > 0;
        if (!reachedRace) await delay(10);
      }
      assert.ok(reachedRace, 'refund reaches the issuance transaction before the snapshot is released');
    } finally {
      releaseSnapshot();
      await Promise.all([completing, delivering]);
    }
    await passes.webhook(event);
    await passes.reconcileRefunds();
    assert.equal(await passCount(date), 0);
    const row = await readCheckout(id);
    assert.deepEqual([row.status, row.refund_status, row.refund_reconcile_after], ['cancelled', 'succeeded', null]);
  });
}

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

async function holdPartiallyRefundedVisit(t: TestContext, date: string) {
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
  return { id, intent, refund, held, verifyCapture: () => { captured = true; } };
}
async function honorPartiallyRefundedVisit(t: TestContext, date: string) {
  const visit = await holdPartiallyRefundedVisit(t, date);
  visit.verifyCapture();
  await passes.staffRefund(admin, visit.id, 'Honor the visit', true, true);
  return visit;
}

test('staff can honor a held visit after verifying a settled partial refund', async t => {
  const date = '2034-05-16';
  const { id, refund, held, verifyCapture } = await holdPartiallyRefundedVisit(t, date);
  await assert.rejects(staff.issue(admin, member, desk(date)), { code: 'CHECKOUT_OPEN', message: /already paid by card.*Review refund/ });
  // Keep the old review action safe by default, and refuse if Stripe cannot verify capture.
  await assert.rejects(passes.staffRefund(admin, id, 'Check the partial refund', true), { code: 'RECONCILE_REQUIRED' });
  const honorVisit = () => passes.staffRefund(admin, id, 'Honor the visit', true, true);
  await assert.rejects(async () => honorVisit(), { code: 'RECONCILE_REQUIRED' });
  assert.equal(await passCount(date), 0);
  verifyCapture();
  assert.deepEqual(await honorVisit(), { status: 'reviewed', passIssued: true });
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

});

test('an unchanged refund update leaves an honored partial refund accepted', async t => {
  const date = '2034-05-17';
  const { refund } = await honorPartiallyRefundedVisit(t, date);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.updated', refund));
  assert.equal((await checkoutRow(date)).refund_needs_review, false, 'the accepted partial refund is unchanged');
  const additional = { ...refund, id: 're_' + randomUUID(), amount: 100 };
  refunds.unshift(additional);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', additional));
  assert.equal((await checkoutRow(date)).refund_needs_review, true, 'additional settled refunds require review');
});

test('the worker settles the remaining refund after the old webhook rejects it', async t => {
  const date = '2034-05-18';
  const { id, intent, refund } = await honorPartiallyRefundedVisit(t, date);
  refunds.unshift({ ...refund, id: 're_' + randomUUID(), amount: 1000 });
  const event = stripeEvent('evt_' + randomUUID(), 'refund.created', refunds[0]!);
  // c95a2b57 checks the single refund against the whole checkout, then rolls back.
  await assert.rejects(transaction(pool, async db => {
    await db.query('INSERT INTO app_pass_stripe_event(id) VALUES($1)', [event.id]);
    const row = (await db.query<{amount_cents:number}>('SELECT amount_cents FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE', [intent])).rows[0]!;
    if (row.amount_cents !== refunds[0]!.amount) throw new AppError(409, 'RECONCILE_REQUIRED', 'Refund amount mismatch.');
  }), { status: 409, code: 'RECONCILE_REQUIRED' });
  assert.equal((await pool.query('SELECT 1 FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 0);
  await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now()-interval '1 second' WHERE id=$1 AND refund_reconcile_after IS NOT NULL", [id]);
  await passes.reconcileRefunds();
  assert.equal(await passCount(date), 0, 'refunds covering the full amount cancel access without a redelivery');
  assert.equal((await checkoutRow(date)).refund_status, 'succeeded');
});

for (const { name, date, daysSinceHonor } of [
  { name: 'the worker follows a pending remainder beyond three days until it settles', date: '2034-08-02', daysSinceHonor: 4 },
  { name: 'a pending remainder remains under review and is polled daily after 30 days', date: '2034-08-09', daysSinceHonor: 31 },
]) {
  test(name, async t => {
    const { id, intent, refund } = await holdPartiallyRefundedVisit(t, date);
    // Backdate the honor decision without mutating append-only history.
    await transaction(pool, async db => {
      const row = (await db.query<Parameters<PassBilling['issue']>[1]>('SELECT * FROM app_pass_checkout WHERE id=$1', [id])).rows[0]!;
      await passes.issue(db, row, row.checkout_id!);
      await db.query("UPDATE app_pass_checkout SET refund_needs_review=false,refund_status='partial',refund_reconcile_after=now() WHERE id=$1", [id]);
      await db.query(`INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,after_state,created_at)
        VALUES($1,$2,'billing.refund.reviewed','payment',$3,'Honor the visit',$4,now()-$5*interval '1 day')`,
      [admin, member, row.payment_id, { checkoutId: id, refundIds: [refund.id], refundedCents: 500 }, daysSinceHonor]);
    });
    const remainder: Refund = { ...refund, id: 're_' + randomUUID(), status: 'pending', amount: 1000, payment_intent: intent };
    refunds.unshift(remainder);
    await passes.reconcileRefunds();
    const observed = await readCheckout(id);
    assert.equal(observed.refund_needs_review, true);
    assert.equal(await passCount(date), 1);
    if (daysSinceHonor > 30) {
      assert.ok(observed.refund_reconcile_after.getTime() > Date.now() + 23 * 3600 * 1000);
      return;
    }
    assert.ok(observed.refund_reconcile_after, 'pending remainder stays scheduled beyond three days');

    // Stripe settles it while c95a2b57 handles deliveries and rejects the single amount.
    remainder.status = 'succeeded';
    await pool.query("UPDATE app_pass_checkout SET refund_reconcile_after=now() WHERE id=$1 AND refund_reconcile_after IS NOT NULL", [id]);
    await passes.reconcileRefunds();
    assert.equal(await passCount(date), 0);
    assert.equal((await readCheckout(id)).refund_status, 'succeeded');
  });
}

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

async function replaceLegacyCheckout(t: TestContext, date: string) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(date + 'T03:50:00Z') });
  const { id, session } = await openCheckout(date);
  // The old release selected this row and started creating a session just before midnight.
  await pool.query('UPDATE app_pass_checkout SET checkout_id=NULL,created_at=$2 WHERE id=$1', [id, new Date()]);
  sessions.delete(session.id!);
  t.mock.timers.tick(20 * 60 * 1000);
  assert.ok((await passes.checkout(member, await input(date))).checkoutUrl);
  const replacement = await checkoutRow(date);
  assert.notEqual(replacement.id, id);

  // c95a2b57 binds by id and NULL checkout_id only, then returns the open session URL.
  sessions.set(session.id!, session);
  const bound = await pool.query('UPDATE app_pass_checkout SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL', [id, session.id]);
  assert.equal(bound.rowCount, 1);
  return { id, session, replacement, replacementSession: sessions.get(replacement.checkout_id)! };
}
const readCheckout = async (id: string) =>
  (await pool.query('SELECT * FROM app_pass_checkout WHERE id=$1', [id])).rows[0];

test('the worker recovers an old-release checkout conflict and expires the pending replacement in Stripe', async t => {
  const date = '2034-07-20';
  const { id, session, replacement, replacementSession } = await replaceLegacyCheckout(t, date);
  assert.equal((await readCheckout(id)).status, 'expired');
  assert.equal((await readCheckout(replacement.id)).status, 'pending');

  const event = capture(session);
  await assert.rejects(oldCheckoutDelivery(event, session), { code: '23505', constraint: 'app_pass_checkout_one_open' });
  assert.equal((await pool.query('SELECT 1 FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 0);
  assert.equal((await readCheckout(id)).payment_id, null);
  await passes.reconcileRefunds();

  const accepted = await readCheckout(id);
  assert.equal(accepted.status, 'paid');
  assert.ok(accepted.payment_id);
  assert.ok(accepted.pass_id);
  assert.equal((await readCheckout(replacement.id)).status, 'expired');
  assert.equal(replacementSession.status, 'expired', 'Stripe closes the replacement URL');
  assert.equal(await passCount(date), 1);
  assert.equal(refundKeys.length, 0);
});

test('a replacement capture that beats Stripe expiration is refunded by the worker', async t => {
  const date = '2034-07-22';
  const { id, session, replacement, replacementSession } = await replaceLegacyCheckout(t, date);
  stripe.checkoutSessionExpire(async stripeId => {
    assert.equal(stripeId, replacementSession.id);
    capture(replacementSession);
    throw new Stripe.errors.StripeInvalidRequestError({ message: 'Checkout Session is already complete' });
  });
  t.after(() => stripe.checkoutSessionExpire(expireSession));

  await pay(session);
  const accepted = await readCheckout(id), duplicate = await readCheckout(replacement.id);
  assert.equal(accepted.status, 'paid');
  assert.deepEqual([duplicate.status, duplicate.refund_status, duplicate.pass_id], ['cancelled', 'succeeded', null]);
  assert.ok(duplicate.payment_id && duplicate.payment_id !== accepted.payment_id);
  assert.equal(await passCount(date), 1);
  assert.deepEqual(refundKeys, ['daypass-refund:' + replacement.id]);
});

test('a delayed replacement capture is refunded even after staff refund the original pass', async t => {
  const date = '2034-07-23';
  const { id, session, replacement, replacementSession } = await replaceLegacyCheckout(t, date);
  stripe.checkoutSessionExpire(async () => { throw new Error('Stripe expiration unavailable'); });
  t.after(() => stripe.checkoutSessionExpire(expireSession));
  await pay(session);
  const duplicateEvent = capture(replacementSession);
  await passes.staffRefund(admin, id, 'Original pass refunded');
  assert.equal(await passCount(date), 0);

  await passes.webhook(duplicateEvent);
  const duplicate = await readCheckout(replacement.id);
  assert.ok(duplicate.payment_id);
  assert.deepEqual([duplicate.status, duplicate.refund_status, duplicate.pass_id], ['cancelled', 'succeeded', null]);
  assert.equal(await passCount(date), 0);
  assert.deepEqual(refundKeys, ['daypass-refund:' + id, 'daypass-refund:' + replacement.id]);
});

const rollbackQuery = () => readFile(new URL('../../../database/fixes/list-day-pass-rollback-payments.sql', import.meta.url), 'utf8');

test('staff close an old-webhook reissue after a full refund and the worker leaves it closed', async () => {
  const date = '2034-08-03';
  const { id, session } = await openCheckout(date);
  const event = capture(session);
  const fullRefund: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd',
    payment_intent: session.payment_intent as string };
  refunds.unshift(fullRefund);
  await passes.webhook(event);
  const cancelled = await readCheckout(id);
  assert.deepEqual([cancelled.status, cancelled.pass_id], ['cancelled', null]);

  await oldCheckoutDelivery(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session), session, fullRefund);
  const reissued = await readCheckout(id);
  assert.equal(reissued.status, 'paid');
  assert.equal(reissued.refund_reconcile_after, null);
  assert.equal(await passCount(date), 1);
  await passes.reconcileRefunds();
  assert.equal((await readCheckout(id)).refund_needs_review, true);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === reissued.payment_id)?.refundStatus, 'needs_review');
  // The operator query must also work with only the previous app running.
  await pool.query('UPDATE app_pass_checkout SET refund_needs_review=false WHERE id=$1', [id]);
  const flagged = (await pool.query(await rollbackQuery())).rows.find(r => r.checkout_id === id);
  assert.equal(flagged?.active_after_full_refund, true);
  assert.deepEqual(flagged?.matching_stripe_payment_ids, [cancelled.payment_id, reissued.payment_id]);
  await pool.query('UPDATE payment SET reference=$2 WHERE paymentid=$1', [cancelled.payment_id, session.payment_intent]);
  const mixedReferences = (await pool.query(await rollbackQuery())).rows.find(r => r.checkout_id === id);
  assert.deepEqual(mixedReferences?.matching_stripe_payment_ids, flagged?.matching_stripe_payment_ids);
  await passes.reconcileRefunds();
  assert.deepEqual(await passes.staffRefund(admin, id, 'Close the refunded pass', true),
    { status: 'reviewed', passCancelled: true });
  await passes.reconcileRefunds();
  const reviewed = await readCheckout(id);
  assert.deepEqual([reviewed.status, reviewed.refund_needs_review, await passCount(date)], ['cancelled', false, 0]);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === reissued.payment_id)?.status, 'refunded');
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === cancelled.payment_id)?.status, 'void');
  assert.ok(!(await pool.query(await rollbackQuery())).rows.some(r => r.checkout_id === id));
  assert.equal(refundKeys.length, 0);
});

test('staff explicitly keep an old-webhook pass for a retired replacement without reflagging', async t => {
  const date = '2034-08-04';
  const { id, session, replacement, replacementSession } = await replaceLegacyCheckout(t, date);
  stripe.checkoutSessionExpire(async () => { throw new Error('Stripe expiration unavailable'); });
  t.after(() => stripe.checkoutSessionExpire(expireSession));
  await pay(session);
  await passes.staffRefund(admin, id, 'Original pass refunded');
  await oldCheckoutDelivery(capture(replacementSession), replacementSession);
  const reissued = await readCheckout(replacement.id);
  assert.equal(reissued.status, 'paid');
  assert.equal(await passCount(date), 1);
  await pool.query('UPDATE app_pass_checkout SET refund_reconcile_after=NULL WHERE id=$1', [replacement.id]);
  const flagged = (await pool.query(await rollbackQuery())).rows.find(r => r.checkout_id === replacement.id);
  await passes.reconcileRefunds();
  assert.equal((await readCheckout(replacement.id)).refund_needs_review, true);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === reissued.payment_id)?.refundStatus, 'needs_review');
  assert.equal(flagged?.retired_by_checkout_id, id);
  assert.equal(flagged?.pass_status, 'active');
  assert.deepEqual(refundKeys, ['daypass-refund:' + id], 'detection does not send money');
  await assert.rejects(passes.staffRefund(admin, replacement.id, 'Close without accepting', true), { code: 'RECONCILE_REQUIRED' });
  const retrieve = provider.sdk.paymentIntents.retrieve;
  t.after(() => { provider.sdk.paymentIntents.retrieve = retrieve; });
  const intent = replacementSession.payment_intent as string;
  stripe.paymentIntentRetrieve(async () => ({ id: intent, status: 'succeeded', livemode: false, latest_charge: {
    id: 'ch_' + randomUUID(), payment_intent: intent, livemode: false, paid: true, status: 'succeeded', captured: true,
    amount_captured: 1500, currency: 'usd',
  } }));
  assert.deepEqual(await passes.staffRefund(admin, replacement.id, 'Keep the replacement visit', true, true),
    { status: 'reviewed', passKept: true });
  await passes.reconcileRefunds();
  assert.deepEqual([(await readCheckout(replacement.id)).refund_needs_review, await passCount(date)], [false, 1]);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === reissued.payment_id)?.status, 'paid');
  assert.ok(!(await pool.query(await rollbackQuery())).rows.some(r => r.checkout_id === replacement.id));
});

async function queueUnboundCheckout(date: string, age: string) {
  const { id } = await openCheckout(date);
  await pool.query(`UPDATE app_pass_checkout SET status='expired',checkout_id=NULL,
    created_at=now()-$2::interval,refund_reconcile_after=now() WHERE id=$1`, [id, age]);
  return id;
}

test('checkout discovery bounds Stripe creation dates and pagination', async t => {
  const id = await queueUnboundCheckout('2034-08-05', '10 minutes');
  const row = await readCheckout(id);
  const calls: Stripe.Checkout.SessionListParams[] = [];
  const list = provider.sdk.checkout.sessions.list;
  t.after(() => { provider.sdk.checkout.sessions.list = list; });
  stripe.checkoutSessionList(async params => {
    calls.push(structuredClone(params!));
    return { data: [{ id: 'cs_other_' + calls.length }], has_more: calls.length < 4 };
  });
  await passes.reconcileRefunds();
  assert.equal(calls.length, 3);
  const started = Math.floor(row.created_at.getTime() / 1000);
  assert.deepEqual(calls.map(call => call.created), Array(3).fill({ gte: started - 60, lte: started + 23 * 3600 + 60 }));
  assert.deepEqual(calls.map(call => call.starting_after), [undefined, 'cs_other_1', 'cs_other_2']);
  const escalated = await readCheckout(id);
  assert.equal(escalated.refund_needs_review, true);
  assert.equal(escalated.refund_reconcile_after, null);
  assert.ok((await pool.query(await rollbackQuery())).rows.some(r => r.checkout_id === id));
});

test('checkout discovery backs off empty results and escalates after the recovery window', async t => {
  const id = await queueUnboundCheckout('2034-08-06', '12 hours');
  const list = provider.sdk.checkout.sessions.list;
  t.after(() => { provider.sdk.checkout.sessions.list = list; });
  stripe.checkoutSessionList(async () => ({ data: [], has_more: false }));
  await passes.reconcileRefunds();
  assert.ok((await readCheckout(id)).refund_reconcile_after.getTime() > Date.now() + 60 * 60 * 1000);

  await pool.query("UPDATE app_pass_checkout SET created_at=now()-interval '48 hours',refund_reconcile_after=now() WHERE id=$1", [id]);
  await passes.reconcileRefunds();
  const escalated = await readCheckout(id);
  assert.deepEqual([escalated.refund_needs_review, escalated.refund_reconcile_after], [true, null]);
});

test('provider lookup failures back off and stop at the reconciliation deadline', async t => {
  const { id, session } = await openCheckout('2034-08-07');
  const event = capture(session);
  await pool.query("UPDATE app_pass_checkout SET created_at=now()-interval '12 hours' WHERE id=$1", [id]);
  stripe.refundList(async () => { throw new Error('Stripe lookup unavailable'); });
  t.after(() => stripe.refundList(listRefunds));
  await assert.rejects(passes.webhook(event), /Stripe lookup unavailable/);
  assert.ok((await readCheckout(id)).refund_reconcile_after.getTime() > Date.now() + 30 * 60 * 1000);

  await pool.query("UPDATE app_pass_checkout SET created_at=now()-interval '48 hours',refund_reconcile_after=now() WHERE id=$1", [id]);
  await passes.reconcileRefunds();
  const escalated = await readCheckout(id);
  assert.deepEqual([escalated.refund_needs_review, escalated.refund_reconcile_after], [true, null]);
  assert.ok(escalated.payment_id, 'review must have a ledger payment');
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === escalated.payment_id)?.refundStatus, 'needs_review');
  await assert.rejects(staff.issue(admin, member, desk('2034-08-07')), { code: 'CHECKOUT_OPEN' });
});

test('a distinct old-release completion during a refund lookup outage leaves one ledger entry', async () => {
  const date = '2034-07-24';
  const { id, session } = await openCheckout(date);
  const first = capture(session);
  stripe.refundList(async () => { throw new Error('Stripe refund lookup unavailable'); });
  try {
    await assert.rejects(passes.webhook(first), /Stripe refund lookup unavailable/);
  } finally {
    stripe.refundList(listRefunds);
  }
  assert.ok((await readCheckout(id)).refund_reconcile_after);

  await oldCheckoutDelivery(stripeEvent('evt_' + randomUUID(), 'checkout.session.completed', session), session);
  await passes.reconcileRefunds();
  await passes.webhook(first);
  assert.equal(await passCount(date), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment WHERE reference=$1', [session.id])).rows[0].n, 1);
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
  assert.equal(queued?.stripe_session_id, session.id);
  assert.equal(queued?.ledger_status, null);
  assert.equal(queued?.pass_id, null);
  assert.ok(queued?.refund_reconcile_after);
  assert.equal(await passCount(date), 0);

  // The compatible worker can resume the payment with the same payment ID and no new charge.
  stripe.refundList(listRefunds);
  await passes.webhook(event);
  assert.ok((await checkoutRow(date)).payment_id);
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

test('staff must explicitly honor a held visit even when all refunds have failed', async t => {
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
  await assert.rejects(passes.staffRefund(admin, held.id, 'Both partial refunds failed', true), { code: 'RECONCILE_REQUIRED' });
  assert.equal(await passCount(date), 0);
  const retrieve = provider.sdk.paymentIntents.retrieve;
  t.after(() => { provider.sdk.paymentIntents.retrieve = retrieve; });
  stripe.paymentIntentRetrieve(async () => ({ id: intent, livemode: false, status: 'succeeded', latest_charge: {
    id: 'ch_verified', payment_intent: intent, livemode: false, paid: true, status: 'succeeded',
    captured: true, amount_captured: 1500, currency: 'usd',
  } }));
  assert.deepEqual(await passes.staffRefund(admin, held.id, 'Honor the visit', true, true), { status: 'reviewed', passIssued: true });
  const issued = await checkoutRow(date);
  assert.equal(issued.refund_needs_review, false);
  assert.equal(issued.payment_id, held.payment_id);
  assert.equal(issued.status, 'paid');
  assert.equal(await passCount(date), 1);
  assert.equal(refundKeys.length, 0);
});


test('the fresher refund retrieval wins when Stripe lists the same refund as pending', async t => {
  const date = '2034-08-11';
  const { id, session } = await openCheckout(date);
  await pay(session);
  const refund: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd',
    payment_intent: session.payment_intent as string };
  refunds.unshift(refund);
  stripe.refundList(async () => ({ data: [{ ...refund, status: 'pending' }], has_more: false }));
  t.after(() => stripe.refundList(listRefunds));
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.updated', refund));
  stripe.refundList(listRefunds);
  await passes.reconcileRefunds();
  const row = await readCheckout(id);
  assert.deepEqual([row.status, row.refund_status, await passCount(date)], ['cancelled', 'succeeded', 0]);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === row.payment_id)?.status, 'refunded');
});

test('a pending refund on an issued pass stays queued until Stripe settles it', async () => {
  const date = '2034-08-12';
  const { id, session } = await openCheckout(date);
  await pay(session);
  const refund: Refund = { id: 're_' + randomUUID(), status: 'pending', amount: 1500, currency: 'usd',
    payment_intent: session.payment_intent as string };
  refunds.unshift(refund);
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', refund));
  assert.ok((await readCheckout(id)).refund_reconcile_after);
  refund.status = 'succeeded';
  await pool.query('UPDATE app_pass_checkout SET refund_reconcile_after=now() WHERE id=$1', [id]);
  await passes.reconcileRefunds();
  assert.deepEqual([(await readCheckout(id)).status, await passCount(date)], ['cancelled', 0]);
});

test('a terminal refund lookup failure leaves a captured charge that staff can resolve', async t => {
  const date = '2034-08-13';
  const { id, session } = await openCheckout(date);
  const event = capture(session);
  stripe.refundList(async () => { throw new Stripe.errors.StripePermissionError({ message: 'Refund lookup forbidden' }); });
  t.after(() => stripe.refundList(listRefunds));
  await assert.rejects(passes.webhook(event), /Refund lookup forbidden/);
  const held = await readCheckout(id);
  assert.ok(held.payment_id);
  assert.equal(held.refund_reconcile_after, null);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === held.payment_id)?.refundStatus, 'needs_review');
  stripe.refundList(listRefunds);
  const refund: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd',
    payment_intent: session.payment_intent as string };
  refunds.unshift(refund);
  assert.deepEqual(await passes.staffRefund(admin, id, 'Verified full refund in Stripe', true), { status: 'reviewed' });
  const settled = await readCheckout(id);
  assert.deepEqual([settled.payment_id, settled.status, settled.refund_needs_review, await passCount(date)],
    [held.payment_id, 'cancelled', false, 0]);
});

for (const [action, date] of [['resume', '2034-08-14'], ['cancel', '2034-08-15']]) {
  test(`member ${action} schedules bounded checkout discovery for worker review`, async t => {
    const { id, session } = await openCheckout(date!);
    sessions.delete(session.id!);
    await pool.query("UPDATE app_pass_checkout SET checkout_id=NULL,created_at=now()-interval '25 hours' WHERE id=$1", [id]);
    const list = provider.sdk.checkout.sessions.list;
    t.after(() => { provider.sdk.checkout.sessions.list = list; });
    stripe.checkoutSessionList(async () => ({ data: [{ id: 'cs_other' }], has_more: true }));
    const body = await input(date!);
    await assert.rejects(action === 'resume' ? passes.checkout(member, body) : passes.cancel(member, id), { code: 'CHECKOUT_SEARCH_LIMIT' });
    assert.ok((await readCheckout(id)).refund_reconcile_after);
    await passes.reconcileRefunds();
    const flagged = await readCheckout(id);
    assert.deepEqual([flagged.refund_needs_review, flagged.refund_reconcile_after], [true, null]);
    assert.ok((await pool.query(await rollbackQuery())).rows.some(r => r.checkout_id === id));
  });
}

test('a member returning to a paid Stripe checkout queues capture recovery before the webhook arrives', async () => {
  const date = '2034-08-16';
  const { id, session } = await openCheckout(date);
  capture(session);
  const body = await input(date);
  await assert.rejects(passes.checkout(member, body), { code: 'PAYMENT_PROCESSING' });
  assert.ok((await readCheckout(id)).refund_reconcile_after);
  await passes.reconcileRefunds();
  assert.equal(await passCount(date), 1);
});

test('an automatic refund that fails leaves the unissued charge in staff review', async () => {
  const date = '2034-08-17';
  await staff.issue(admin, member, desk(date));
  const { id, session } = await openCheckout(date);
  nextRefund = 'failed';
  await pay(session);
  const held = await readCheckout(id);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === held.payment_id)?.refundStatus, 'needs_review');
  assert.equal(held.pass_id, null);
  assert.equal(await passCount(date), 1);
});


test('the worker recovers a capture already stranded by the previous deadline handling', async () => {
  const date = '2034-08-18';
  const { id, session } = await openCheckout(date);
  const event = capture(session);
  await pool.query(`UPDATE app_pass_checkout SET payment_intent=$2,refund_needs_review=true,
    created_at=now()-interval '3 days' WHERE id=$1`, [id, session.payment_intent]);
  await pool.query('INSERT INTO app_pass_stripe_event(id) VALUES($1)', [event.id]);

  await passes.reconcileRefunds();
  const held = await readCheckout(id);
  assert.ok(held.payment_id);
  assert.deepEqual([held.pass_id, held.refund_reconcile_after], [null, null]);
  assert.equal((await new StaffModel(pool).payments(member)).find(p => p.id === held.payment_id)?.refundStatus, 'needs_review');
  await passes.webhook(event);
  assert.equal((await readCheckout(id)).payment_id, held.payment_id);
});

test('a paid Checkout delivery can replay when Stripe temporarily retrieves an open session', async t => {
  const date = '2034-08-19';
  const { id, session } = await openCheckout(date);
  const event = capture(session);
  const retrieve = provider.sdk.checkout.sessions.retrieve;
  t.after(() => { provider.sdk.checkout.sessions.retrieve = retrieve; });
  stripe.checkoutSessionRetrieve(async () => ({ ...session, status: 'open', payment_status: 'unpaid' }));

  await assert.rejects(passes.webhook(event), { code: 'PAYMENT_PROCESSING' });
  assert.equal((await pool.query('SELECT 1 FROM app_pass_stripe_event WHERE id=$1', [event.id])).rowCount, 0);
  provider.sdk.checkout.sessions.retrieve = retrieve;
  await passes.webhook(event);
  assert.deepEqual([(await readCheckout(id)).status, await passCount(date)], ['paid', 1]);
});
