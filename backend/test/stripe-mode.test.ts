import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { assertStripeMode, inStripeMode, keyMatchesMode, modeOf, paymentLabels, readStripeMode } from '../src/stripeMode.js';
import { overlappingCardPaymentNote, OVERLAPPING_CARD_PAYMENT_NOTE } from '../src/models/staff/payments.js';
import { studioWebhook } from '../src/studios/routes.js';
import { stripeModeOf } from '../src/config.js';
import { readStudioStripeConfig, StudioStripe } from '../src/studios/stripe.js';
import { MembershipBilling } from '../src/billing/service.js';
import { PassBilling } from '../src/billing/passes.js';
import { StudioService } from '../src/studios/service.js';

const stripeSettings = ['STRIPE_MODE', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_STUDIO_WEBHOOK_SECRET', 'APP_ORIGIN'];

/** readStudioStripeConfig with only these settings, restoring the environment afterwards. */
function stripeConfigWith(settings: Record<string, string>) {
  const previous = Object.fromEntries(stripeSettings.map((name) => [name, process.env[name]]));
  try {
    for (const name of stripeSettings) delete process.env[name];
    Object.assign(process.env, settings);
    return readStudioStripeConfig();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const configured = (mode: string | undefined, key: string) => stripeConfigWith({
  ...(mode === undefined ? {} : { STRIPE_MODE: mode }),
  STRIPE_TEST_SECRET_KEY: key, STRIPE_STUDIO_WEBHOOK_SECRET: 'whsec_fixture', APP_ORIGIN: 'https://members.example',
});
const settings = { webhookSecret: 'whsec_fixture', origin: 'http://localhost' };

test('STRIPE_MODE defaults to test, and only test or live start the app', () => {
  assert.equal(readStripeMode(undefined), 'test');
  assert.equal(readStripeMode(''), 'test');
  assert.equal(readStripeMode('test'), 'test');
  assert.equal(readStripeMode('live'), 'live');
  for (const value of ['LIVE', 'Live', ' live', 'production', 'true', '1', 'sandbox'])
    assert.throws(() => readStripeMode(value), /STRIPE_MODE must be "test" or "live"/, value);
});

test('startup config: test is the default mode, and a bad STRIPE_MODE fails even with Stripe disabled', () => {
  assert.equal(configured(undefined, 'sk_test_fixture')?.mode, 'test');
  assert.equal(configured('', 'rk_test_fixture')?.mode, 'test');
  assert.equal(stripeConfigWith({}), undefined);
  assert.throws(() => stripeConfigWith({ STRIPE_MODE: 'prod' }), /STRIPE_MODE/);
  assert.throws(() => configured('Live', 'sk_live_fixture'), /STRIPE_MODE/);
});

test('test mode accepts only test keys at startup; live mode accepts only live keys', () => {
  for (const key of ['sk_test_fixture', 'rk_test_fixture']) {
    assert.equal(configured('test', key)?.mode, 'test');
    assert.throws(() => configured('live', key), /STRIPE_MODE=live only accepts a Stripe live key/, key);
  }
  for (const key of ['sk_live_fixture', 'rk_live_fixture']) {
    assert.equal(configured('live', key)?.mode, 'live');
    assert.throws(() => configured(undefined, key), /only accepts a Stripe test key/, key);
    assert.throws(() => configured('test', key), /only accepts a Stripe test key/, key);
  }
  for (const key of ['pk_live_fixture', 'pk_test_fixture', 'whsec_fixture', 'sk_fixture'])
    for (const mode of ['test', 'live']) assert.throws(() => configured(mode, key), /only accepts a Stripe (test|live) key/, `${mode} ${key}`);
});

test('the adapter refuses a key from the other mode, defaulting to test', () => {
  for (const key of ['sk_test_fixture', 'rk_test_fixture']) {
    assert.equal(new StudioStripe({ key, ...settings }).mode, 'test');
    assert.equal(new StudioStripe({ key, ...settings, mode: 'test' }).mode, 'test');
    assert.throws(() => new StudioStripe({ key, ...settings, mode: 'live' }), /Live keys only/);
  }
  for (const key of ['sk_live_fixture', 'rk_live_fixture']) {
    assert.equal(new StudioStripe({ key, ...settings, mode: 'live' }).mode, 'live');
    assert.throws(() => new StudioStripe({ key, ...settings }), /Test keys only/);
    assert.throws(() => new StudioStripe({ key, ...settings, mode: 'test' }), /Test keys only/);
  }
});

test('the shared helper rejects objects from the other mode in both directions', () => {
  assert.ok(keyMatchesMode('rk_live_x', 'live') && !keyMatchesMode('rk_live_x', 'test'));
  assert.equal(modeOf(undefined), 'test');
  assert.equal(modeOf({ mode: 'live' }), 'live');
  assert.ok(inStripeMode('test', false) && inStripeMode('test', undefined) && !inStripeMode('test', true));
  assert.ok(inStripeMode('live', true) && !inStripeMode('live', false) && !inStripeMode('live', undefined));
  assert.doesNotThrow(() => assertStripeMode('test', false));
  assert.doesNotThrow(() => assertStripeMode('live', true));
  assert.throws(() => assertStripeMode('test', true, 'events'), { status: 400, code: 'LIVE_PAYMENT_FORBIDDEN', message: 'Test events only.' });
  assert.throws(() => assertStripeMode('live', false, 'events'), { status: 400, code: 'TEST_PAYMENT_FORBIDDEN', message: 'Live events only.' });
  assert.throws(() => assertStripeMode('live', undefined), { code: 'TEST_PAYMENT_FORBIDDEN' });
});

const testProvider = () => new StudioStripe({ key: 'sk_test_fixture', ...settings });
const liveProvider = () => new StudioStripe({ key: 'sk_live_fixture', ...settings, mode: 'live' });
// Webhook mode is checked before any database or Stripe call, so no pool is needed.
const noPool = new Proxy({}, { get() { throw new Error('database must not be used'); } }) as Pool;
const handlers = (provider: StudioStripe) => ({
  memberships: new MembershipBilling(noPool, provider),
  passes: new PassBilling(noPool, provider),
  studios: new StudioService(noPool, 'America/New_York', provider),
});
const event = (livemode: boolean) =>
  ({ id: 'evt_mode', object: 'event', livemode, type: 'checkout.session.completed', data: { object: { id: 'cs_mode' } } }) as unknown as Stripe.Event;

test('webhooks reject an event whose mode does not match, in both directions', async () => {
  for (const [name, handler] of Object.entries(handlers(testProvider())))
    await assert.rejects(handler.webhook(event(true)), { code: 'LIVE_PAYMENT_FORBIDDEN' }, name);
  for (const [name, handler] of Object.entries(handlers(liveProvider())))
    await assert.rejects(handler.webhook(event(false)), { code: 'TEST_PAYMENT_FORBIDDEN' }, name);
});

test('studio checkout refuses a session from the other mode, in both directions', async () => {
  const rental = { id: 1, amount_cents: 100, hold_until: new Date(Date.now() + 3600000), starts_on: '2030-01-01', ends_on: '2030-02-01' };
  for (const [provider, livemode, code] of [[testProvider(), true, 'LIVE_PAYMENT_FORBIDDEN'], [liveProvider(), false, 'TEST_PAYMENT_FORBIDDEN']] as const) {
    (provider.sdk.checkout.sessions.create as unknown) = async () => ({ id: 'cs_mode', livemode });
    await assert.rejects(provider.checkout(rental as never), { status: 503, code });
    (provider.sdk.checkout.sessions.create as unknown) = async () => ({ id: 'cs_mode', livemode: !livemode });
    assert.equal((await provider.checkout(rental as never)).id, 'cs_mode');
  }
});

test('payment wording mentions test mode only in test mode', () => {
  assert.deepEqual(paymentLabels('test'), {
    card: 'Card (test mode)', originalCard: 'Original card (test mode)',
    equipmentNote: 'Online equipment reservation (Stripe test mode)', membershipNote: 'Stripe test recurring membership',
    invoiceNote: 'Stripe test invoice', unavailable: 'Stripe test payments are not configured.',
  });
  assert.equal(paymentLabels('live').card, 'Card');
  assert.equal(paymentLabels('live').originalCard, 'Original card');
  for (const text of Object.values(paymentLabels('live'))) assert.doesNotMatch(text, /test/i);
  assert.equal(OVERLAPPING_CARD_PAYMENT_NOTE, 'Stripe test recurring membership; overlaps another membership');
  assert.equal(overlappingCardPaymentNote('live'), 'Stripe recurring membership; overlaps another membership');
});

test('the webhook says which mode is not configured', async () => {
  await assert.rejects(studioWebhook(noPool, 'America/New_York')({} as never, {} as never),
    { status: 503, code: 'PAYMENTS_UNAVAILABLE', message: 'Stripe test payments are not configured.' });
  await assert.rejects(studioWebhook(noPool, 'America/New_York', undefined, 'live')({} as never, {} as never),
    { status: 503, code: 'PAYMENTS_UNAVAILABLE', message: 'Stripe payments are not configured.' });
});

test('startup config records STRIPE_MODE even when Stripe is off', () => {
  const previous = process.env.STRIPE_MODE;
  try {
    delete process.env.STRIPE_MODE;
    assert.equal(stripeModeOf({ stripeMode: readStripeMode() }), 'test');
    process.env.STRIPE_MODE = 'live';
    assert.equal(stripeModeOf({ stripeMode: readStripeMode() }), 'live');
    assert.equal(stripeModeOf({}), 'test');
    assert.equal(stripeModeOf({ studioStripe: { key: 'sk_live_x', ...settings, mode: 'live' } }), 'live');
  } finally {
    if (previous === undefined) delete process.env.STRIPE_MODE;
    else process.env.STRIPE_MODE = previous;
  }
});
