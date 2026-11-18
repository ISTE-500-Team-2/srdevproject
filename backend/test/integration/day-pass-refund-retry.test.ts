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
// Stripe's list and single-refund reads are not always in step: these overlay a lagging view of one refund.
const listLag = new Map<string, Refund>(), readLag = new Map<string, Refund>();
const keys: string[] = [], byKey = new Map<string, Refund>();
let onCreate: ((id: string) => void) | undefined;
stripe.refundList(async params => ({ data: refunds.filter(f => f.payment_intent === params?.payment_intent && !hidden.has(f.id!))
  .map(f => ({ ...f, ...listLag.get(f.id!) })), has_more: false }));
stripe.refundRetrieve(async id => { const f = refunds.find(r => r.id === id)!; return { ...f, ...readLag.get(id) }; });
stripe.refundCreate(async (params, options) => {
  const key = options!.idempotencyKey!;
  keys.push(key);
  if (byKey.has(key)) return byKey.get(key)!;
  const refund: Refund = { id: 're_' + randomBytes(4).toString('hex'), object: 'refund', status: nextStatus,
    amount: params!.amount!, currency: 'usd', payment_intent: params!.payment_intent as string, created: refunds.length,
    metadata: params!.metadata as Record<string, string> ?? {} };
  refunds.unshift(refund); byKey.set(key, refund);
  onCreate?.(refund.id!);
  return { ...refund };
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
  const retry = async () => (await pool.query('SELECT refund_reconcile_after IS NOT NULL AS scheduled,refund_needs_review AS review FROM app_pass_checkout WHERE id=$1', [id])).rows[0];
  /** Runs the reconciliation job as if this checkout's retry were due now. */
  const runRetry = async () => {
    await pool.query('UPDATE app_pass_checkout SET refund_reconcile_after=now() WHERE id=$1 AND refund_reconcile_after IS NOT NULL', [id]);
    await passes.reconcileRefunds();
  };
  const audits = async () => (await pool.query(`SELECT count(*)::int AS n FROM app_staff_audit a JOIN app_pass_checkout c ON a.entity_id=c.payment_id
    WHERE c.id=$1 AND a.action='daypass.refunded'`, [id])).rows[0].n as number;
  return { id, pi, state, emails, retry, runRetry, audits };
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
  const listed = async () => (await model.payments(member)).find(p => p.passCheckoutId === pass.id)?.refundStatus;
  assert.equal(await listed(), 'needs_review', 'successful settlement does not close a staff review');
  assert.deepEqual(await passes.staffRefund(admin, pass.id, 'Confirmed both Stripe refunds', true), { status: 'reviewed' });
  assert.equal(await listed(), 'succeeded');
  assert.equal((await pool.query('SELECT id FROM app_notification_outbox WHERE dedupe_key=$1', ['daypass-refund:' + pass.id + ':split'])).rowCount, 1);
  assert.equal(keys.length, previousCreates);
});

test('delayed failure of a full refund cannot undo its successful split replacements', async () => {
  const pass = await paidPass('2033-08-01');
  nextStatus = 'succeeded';
  await passes.cancel(member, pass.id);
  const original = refunds[0]!;
  original.status = 'failed';
  const failed = stripeEvent('evt_' + randomUUID(), 'refund.failed', { ...original });
  const replacements: Refund[] = [500, 1000].map(amount => ({
    id: 're_' + randomUUID(), status: 'succeeded', amount, currency: 'usd', payment_intent: pass.pi,
  }));
  refunds.unshift(...replacements);
  await settle(replacements[1]!.id!, 'succeeded');
  await settle(replacements[0]!.id!, 'succeeded');
  await passes.webhook(failed);
  await passes.webhook(failed);
  assert.deepEqual(await pass.state(), {
    checkout: 'cancelled', refund_id: null, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded',
  });
  assert.equal(refunds.filter(f => f.payment_intent === pass.pi).length, 3);
});

test('both split refunds failing before delivery leave a review staff can close before retrying', async () => {
  const pass = await paidPass('2033-09-01');
  const parts: Refund[] = [500, 1000].map(amount => ({
    id: 're_' + randomUUID(), status: 'succeeded', amount, currency: 'usd', payment_intent: pass.pi,
  }));
  refunds.unshift(...parts);
  await settle(parts[0]!.id!, 'succeeded');
  const staleSuccess = stripeEvent('evt_' + randomUUID(), 'refund.updated', { ...parts[0] });
  parts[0]!.status = 'failed';
  parts[1]!.status = 'failed';
  await settle(parts[1]!.id!, 'failed');
  await passes.webhook(staleSuccess);
  await settle(parts[0]!.id!, 'failed');
  const listed = async () => (await new StaffModel(pool).payments(member)).find(p => p.passCheckoutId === pass.id)?.refundStatus;
  assert.equal(await listed(), 'needs_review');
  assert.deepEqual(await pass.state(), {
    checkout: 'cancelled', refund_id: null, refund_status: null, pass: 'cancelled', payment: 'paid',
  });
  const previousCreates = keys.length;
  assert.deepEqual(await passes.staffRefund(admin, pass.id, 'Both Stripe refunds failed', true), { status: 'reviewed' });
  assert.equal(await listed(), null);
  assert.equal(keys.length, previousCreates);
  nextStatus = 'succeeded';
  assert.deepEqual(await passes.staffRefund(admin, pass.id, 'Retry full refund after review'), { status: 'succeeded' });
  assert.equal(keys.length, previousCreates + 1);
  assert.equal((await pass.state()).payment, 'refunded');
  assert.equal((await pass.state()).pass, 'cancelled');
});

test('a full refund Stripe lists as succeeded while its own read disagrees is retried until it cancels the pass once', async () => {
  const pass = await paidPass('2033-10-01');
  // Refunded in full from the Stripe Dashboard. Stripe's list already shows it succeeded; the single read lags.
  const full: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 1500, currency: 'usd', payment_intent: pass.pi };
  refunds.unshift(full);
  readLag.set(full.id!, { status: 'pending' });
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', { ...full }));
  assert.equal((await pass.state()).pass, 'active', 'an inconsistent view is not trusted yet');
  assert.deepEqual(await pass.retry(), { scheduled: true, review: true }, 'a retry is queued, not only a staff flag');

  // Still inconsistent on the first retry: nothing changes and the retry stays queued.
  await pass.runRetry();
  assert.equal((await pass.state()).pass, 'active');
  assert.equal((await pass.retry()).scheduled, true);

  readLag.clear();
  await pass.runRetry();
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: full.id, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded' });
  assert.equal((await pass.retry()).scheduled, false, 'the retry stops once the refund is recorded');
  // Repeats change nothing: one refund record, one email.
  await pass.runRetry();
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.updated', { ...full }));
  assert.equal(await pass.audits(), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_notification_outbox WHERE dedupe_key LIKE $1', [`daypass-refund:${pass.id}:%`])).rows[0].n, 1);
});

test('a member refund Stripe confirms while a follow-up read disagrees is retried until it cancels the pass', async () => {
  const pass = await paidPass('2033-10-02');
  nextStatus = 'succeeded';
  const previousCreates = keys.length;
  // The create response confirms success; the reads made right after it still show the refund pending.
  onCreate = id => { readLag.set(id, { status: 'pending' }); listLag.set(id, { status: 'pending' }); };
  await assert.rejects(passes.cancel(member, pass.id), { code: 'RECONCILE_REQUIRED' });
  onCreate = undefined;
  assert.equal((await pass.state()).pass, 'active');
  assert.deepEqual(await pass.retry(), { scheduled: true, review: true });

  readLag.clear(); listLag.clear();
  await pass.runRetry();
  assert.deepEqual(await pass.state(), { checkout: 'cancelled', refund_id: refunds[0]!.id, refund_status: 'succeeded', pass: 'cancelled', payment: 'refunded' });
  await pass.runRetry();
  assert.equal(keys.length, previousCreates + 1, 'the retry never submits a second refund');
  assert.equal(await pass.audits(), 1);
});

test('a partial refund seen through an inconsistent list never cancels the pass', async () => {
  const pass = await paidPass('2033-10-03');
  const part: Refund = { id: 're_' + randomUUID(), status: 'succeeded', amount: 500, currency: 'usd', payment_intent: pass.pi };
  refunds.unshift(part);
  readLag.set(part.id!, { status: 'pending' });
  await passes.webhook(stripeEvent('evt_' + randomUUID(), 'refund.created', { ...part }));
  assert.equal((await pass.state()).pass, 'active');
  readLag.clear();
  await pass.runRetry();
  await pass.runRetry();
  assert.deepEqual(await pass.state(), { checkout: 'paid', refund_id: null, refund_status: null, pass: 'active', payment: 'paid' });
  assert.deepEqual(await pass.retry(), { scheduled: false, review: true }, 'staff settle a partial refund; the retry stops once reads agree');
  assert.equal(await pass.audits(), 0);
});
