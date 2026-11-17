import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type Stripe from 'stripe';
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
stripe.refundList(async params => ({ data: refunds.filter(f => f.payment_intent === params?.payment_intent), has_more: false }));
stripe.refundRetrieve(async id => refunds.find(f => f.id === id)!);
stripe.refundCreate(async (params, options) => {
  const key = options!.idempotencyKey!;
  refundKeys.push(key);
  if (byKey.has(key)) return byKey.get(key)!;
  const refund: Refund = { id: 're_' + randomBytes(4).toString('hex'), object: 'refund', status: nextRefund, amount: params!.amount!, currency: 'usd',
    payment_intent: params!.payment_intent as string, metadata: params!.metadata as Record<string, string> ?? {} };
  refunds.unshift(refund); byKey.set(key, refund);
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
  await assert.rejects(staff.issue(admin, member, desk(date)), { code: 'CHECKOUT_OPEN' });
  assert.equal(await passCount(date), 0);
  // Once the session can no longer take payment, the desk can issue the pass.
  await pool.query("UPDATE app_pass_checkout SET created_at=now()-interval '23 hours 1 minute' WHERE userid=$1 AND valid_date=$2", [member, date]);
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

test('a payment that arrives after the visit date ended is refunded, and a failed refund can be retried', async () => {
  const yesterday = (await pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date-1,'YYYY-MM-DD') AS d`, [zone])).rows[0]!.d;
  const { id, session } = await openCheckout(yesterday);
  nextRefund = 'failed';
  await pay(session);
  assert.equal(await passCount(yesterday), 0, 'no pass for a day that is over');
  let row = (await pool.query('SELECT * FROM app_pass_checkout WHERE id=$1', [id])).rows[0];
  assert.deepEqual([row.status, row.refund_status, row.pass_id], ['paid', 'failed', null]);
  assert.match((await notice('daypass-not-issued:' + id)).payload.instructions, /after this date had ended/);
  const failed = await notice(`daypass-refund-failed:${id}:${refunds[0]!.id}`);
  assert.match(failed.payload.instructions, /No pass was issued for it/);
  assert.doesNotMatch(failed.payload.instructions, /still valid/);

  // The visit date has passed, but the refund was never the member's late cancellation: it can be retried.
  nextRefund = 'succeeded';
  assert.deepEqual(await passes.cancel(member, id), { cancelled: true, refundStatus: 'succeeded' });
  row = (await pool.query('SELECT * FROM app_pass_checkout WHERE id=$1', [id])).rows[0];
  assert.deepEqual([row.status, row.refund_status], ['cancelled', 'succeeded']);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1', [row.payment_id])).rows[0].paymentstatus, 'refunded');
});

test('card checkout stops taking payment when the visit date ends', async () => {
  const today = businessToday(zone);
  const started = Date.now();
  await passes.checkout(member, await input(today));
  const expires = sessionParams.at(-1)!.expires_at! * 1000;
  const dayEnd = (await pool.query<{ t: Date }>(`SELECT ((now() AT TIME ZONE $1)::date+1)::timestamp AT TIME ZONE $1 AS t`, [zone])).rows[0]!.t.getTime();
  // Stripe accepts 30 minutes to 24 hours; within that, the session ends with the visit date.
  assert.ok(expires >= started + 30 * 60000 && expires <= started + 24 * 3600000, 'inside Stripe’s window');
  assert.ok(expires <= Math.max(dayEnd, started + 46 * 60000), 'no later than the end of the visit date');

  // A pass for a later date gets the most Stripe allows, short of the hour the app keeps for reconciling.
  await passes.checkout(member, await input('2034-06-10'));
  const later = sessionParams.at(-1)!.expires_at! * 1000;
  assert.ok(Math.abs(later - (started + 23 * 3600000)) < 60000);
});

test('a checkout too close to its end to open a session is expired without calling Stripe', async () => {
  const date = '2034-07-10', body = await input(date), id = randomUUID();
  // Its first session request never reached Stripe, and nearly a day has passed.
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,created_at)
    SELECT $1,$2,tierid,$3,jsonb_build_object('name',tiername),$4,now()-interval '22 hours 45 minutes' FROM membership_tiers WHERE tierid=$5`, [id, member, date, body.amountCents, dayPlan]);
  await assert.rejects(passes.checkout(member, body), { code: 'CHECKOUT_EXPIRED' });
  assert.equal(sessionParams.length, 0);
  assert.equal((await pool.query('SELECT status FROM app_pass_checkout WHERE id=$1', [id])).rows[0].status, 'expired');
  // Trying again starts a fresh checkout with a full window.
  assert.ok((await passes.checkout(member, body) as { checkoutUrl?: string }).checkoutUrl);
  assert.equal(sessionParams.length, 1);
});
