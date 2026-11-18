import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import type Stripe from 'stripe';
import { PassBilling } from '../../src/billing/passes.js';
import { StaffModel } from '../../src/models/StaffModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { stripeEvent, stripeMock, type StripeFixture } from '../helpers/stripeFixtures.js';

type Plan = NonNullable<Awaited<ReturnType<StaffModel['plan']>>>;
type Refund = StripeFixture<Stripe.Refund>;
const database = 'arbor_pass_retry_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
let created = false, member: number, admin: number, day: Plan;
const provider = new StudioStripe({ key: 'sk_test_fixture', webhookSecret: 'whsec_fixture', origin: 'http://localhost' });
const passes = new PassBilling(pool, provider);
const stripe = stripeMock(provider);

// A small Stripe stand-in: refunds per payment intent (newest first) and idempotent creates.
let refunds: Refund[] = [], hidden = new Set<string>(), nextStatus: Stripe.Refund['status'] = 'failed';
const keys: string[] = [], byKey = new Map<string, Refund>();
stripe.refundList(async params => ({ data: refunds.filter(f => f.payment_intent === params?.payment_intent && !hidden.has(f.id!)), has_more: false }));
stripe.refundRetrieve(async id => refunds.find(f => f.id === id)!);
stripe.refundCreate(async (params, options) => {
  const key = options!.idempotencyKey!;
  keys.push(key);
  if (byKey.has(key)) return byKey.get(key)!;
  const refund: Refund = { id: 're_' + randomBytes(4).toString('hex'), object: 'refund', status: nextStatus,
    amount: params!.amount!, currency: 'usd', payment_intent: params!.payment_intent as string, created: refunds.length,
    metadata: params!.metadata as Record<string, string> ?? {} };
  refunds.unshift(refund); byKey.set(key, refund);
  return refund;
});
const settle = (id: string, status: Stripe.Refund['status']) => {
  const refund = refunds.find(f => f.id === id)!; refund.status = status;
  return passes.webhook(stripeEvent('evt_' + randomUUID(), status === 'failed' ? 'refund.failed' : 'refund.updated', { ...refund }));
};

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  admin = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  const model = new StaffModel(pool);
  day = (await model.plan((await pool.query("SELECT tierid FROM membership_tiers WHERE kind='day_pass' LIMIT 1")).rows[0].tierid))!;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

/** A paid, issued online day pass far enough out to cancel. */
async function paidPass(date: string) {
  const model = new StaffModel(pool), id = randomUUID(), pi = 'pi_' + randomBytes(4).toString('hex');
  const pass = await model.createPass(member, day, date, admin, 'Refund retry fixture');
  const payment = await model.createPayment(member, null, '15.00', 'paid', 'card', 'cs_' + id, 'Refund retry fixture', admin);
  await model.linkPassPayment(pass, payment);
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,status,payment_intent,pass_id,payment_id)
    VALUES($1,$2,$3,$4,$5,1500,'paid',$6,$7,$8)`, [id, member, day.id, date, day, pi, pass, payment]);
  const state = async () => (await pool.query(`SELECT c.status AS checkout,c.refund_id,c.refund_status,d.status AS pass,p.paymentstatus AS payment
    FROM app_pass_checkout c JOIN day_pass d ON d.dayid=c.pass_id JOIN payment p ON p.paymentid=c.payment_id WHERE c.id=$1`, [id])).rows[0];
  const emails = async () => (await pool.query(`SELECT payload->>'instructions' AS text FROM app_notification_outbox
    WHERE dedupe_key LIKE $1 ORDER BY id`, [`daypass-refund-failed:${id}:%`])).rows.map(r => r.text as string);
  return { id, pi, state, emails };
}

test('retrying a failed day-pass refund submits a new refund, and the failure email matches the still-active pass', async () => {
  const pass = await paidPass('2033-03-01');
  nextStatus = 'failed';
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'failed' });
  assert.deepEqual(await pass.state(), { checkout: 'paid', refund_id: refunds[0]!.id, refund_status: 'failed', pass: 'active', payment: 'paid' });
  const [email] = await pass.emails();
  assert.match(email!, /has not been cancelled and is still valid\. Retry the refund/);
  assert.doesNotMatch(email!, /remains cancelled/);
  // The member asked to cancel, so Membership & passes offers them the retry.
  assert.equal((await passes.mine(member)).find(p => p.id === pass.id)!.cancelRequested, true);

  const failed = refunds[0]!.id!;
  nextStatus = 'succeeded';
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: true, refundStatus: 'succeeded' });
  assert.equal(refunds.filter(f => f.payment_intent === pass.pi).length, 2, 'the retry created a second refund');
  assert.deepEqual(keys.slice(-2), [`daypass-refund:${pass.id}`, `daypass-refund:${pass.id}:${failed}`]);
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: refunds[0]!.id, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded' });
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: true });
});

test('a repeated retry reuses the in-flight refund, and a replaced attempt failing late changes nothing', async () => {
  const pass = await paidPass('2033-04-01');
  nextStatus = 'failed';
  await passes.cancel(member, pass.id);
  const first = refunds[0]!.id!;
  nextStatus = 'pending';
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'pending' });
  const second = refunds[0]!.id!;
  // Stripe's list may lag a create; the same key returns the same attempt instead of refunding twice.
  hidden.add(second);
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'pending' });
  hidden = new Set();
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'pending' });
  assert.equal(refunds.filter(f => f.payment_intent === pass.pi).length, 2, 'no third refund');

  await settle(first, 'failed');
  assert.deepEqual(await pass.state(), { checkout: 'paid', refund_id: second, refund_status: 'pending', pass: 'active', payment: 'paid' });
  assert.equal((await pass.emails()).length, 1, 'no second failure email for the replaced attempt');
  await settle(second, 'succeeded');
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: second, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded' });

  // A confirmed refund that later fails leaves the cancellation in place, and the email says so.
  await settle(second, 'failed');
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: second, refund_status: 'failed', pass: 'cancelled', payment: 'paid' });
  assert.match((await pass.emails()).at(-1)!, /Your pass stays cancelled/);
});

test('a live refund for the wrong amount still requires reconciliation', async () => {
  const pass = await paidPass('2033-05-01');
  refunds.unshift({ id: 're_partial_' + randomBytes(3).toString('hex'), status: 'pending', amount: 500, currency: 'usd', payment_intent: pass.pi });
  await assert.rejects(passes.cancel(member, pass.id), { code: 'RECONCILE_REQUIRED' });
});

test('a retry that fails at once is recorded even while the attempt it replaced still looks pending here', async () => {
  const pass = await paidPass('2033-06-01');
  nextStatus = 'pending';
  await passes.cancel(member, pass.id);
  const first = refunds[0]!.id!;
  // The first attempt fails at Stripe, but its webhook hasn't arrived: here it still looks pending.
  refunds[0]!.status = 'failed';
  nextStatus = 'failed';
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'failed' });
  const second = refunds[0]!.id!;
  assert.notEqual(second, first);
  assert.deepEqual(await pass.state(), { checkout: 'paid', refund_id: second, refund_status: 'failed', pass: 'active', payment: 'paid' });
  // Both webhooks arrive late: the retry's own failure, then the replaced attempt's. Neither changes the record.
  await settle(second, 'failed');
  await settle(first, 'failed');
  assert.deepEqual(await pass.state(), { checkout: 'paid', refund_id: second, refund_status: 'failed', pass: 'active', payment: 'paid' });
  // So the member can retry again.
  nextStatus = 'pending';
  assert.deepEqual(await passes.cancel(member, pass.id), { cancelled: false, refundStatus: 'pending' });
  assert.equal(refunds.filter(f => f.payment_intent === pass.pi).length, 3);
});

test('refund webhooks reconcile multiple successful partial refunds on an issued pass only once', async () => {
  const pass = await paidPass('2033-07-01');
  const previousCreates = keys.length;
  const first: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1000, currency: 'usd', payment_intent: pass.pi };
  const second: Refund = { id: 're_' + randomUUID(), status: 'pending', amount: 500, currency: 'usd', payment_intent: pass.pi };
  refunds.unshift(first, second);
  await settle(first.id!, 'succeeded');
  assert.equal((await pass.state()).pass, 'active');
  const model = new StaffModel(pool);
  assert.equal((await model.payments(member)).find(p => p.passCheckoutId === pass.id)?.refundStatus, 'needs_review');
  await settle(second.id!, 'succeeded');
  await settle(first.id!, 'succeeded');
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: null, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded' });
  assert.equal((await model.payments(member)).find(p => p.passCheckoutId === pass.id)?.refundStatus, 'succeeded');
  assert.equal((await pool.query('SELECT id FROM app_notification_outbox WHERE dedupe_key=$1', ['daypass-refund:' + pass.id + ':split'])).rowCount, 1);
  assert.equal(keys.length, previousCreates);
});
