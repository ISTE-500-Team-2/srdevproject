// Which Stripe mode the app takes payments in. Test is the default; live is an explicit opt-in
// (STRIPE_MODE=live). Every key and every Stripe object's livemode flag is checked against it.

import { AppError } from './domain.js';

export type StripeMode = 'test' | 'live';

/** Read STRIPE_MODE. Unset or blank means test; anything other than test or live stops startup. */
export function readStripeMode(value = process.env.STRIPE_MODE): StripeMode {
  if (value === undefined || value === '') return 'test';
  if (value === 'test' || value === 'live') return value;
  throw new Error('STRIPE_MODE must be "test" or "live" (leave it unset for test)');
}

const keyPatterns: Record<StripeMode, RegExp> = { test: /^(sk|rk)_test_/, live: /^(sk|rk)_live_/ };

/** A secret (sk_) or restricted (rk_) key for this mode. */
export const keyMatchesMode = (key: string, mode: StripeMode) => keyPatterns[mode].test(key);

/** The mode of a configured provider. No provider means the default test mode. */
export const modeOf = (provider?: { readonly mode: StripeMode }): StripeMode => provider?.mode ?? 'test';

/** Whether a Stripe object belongs to this mode. A missing livemode flag counts as test. */
export const inStripeMode = (mode: StripeMode, livemode: boolean | null | undefined) => !!livemode === (mode === 'live');

/**
 * Reject a Stripe object from the other mode: live objects in test mode (LIVE_PAYMENT_FORBIDDEN, as
 * before live mode existed), and test objects in live mode (TEST_PAYMENT_FORBIDDEN).
 */
export function assertStripeMode(mode: StripeMode, livemode: boolean | null | undefined, what = 'payments',
  { status = 400, testMessage = `Test ${what} only.` }: { status?: number; testMessage?: string } = {}) {
  if (inStripeMode(mode, livemode)) return;
  if (mode === 'test') throw new AppError(status, 'LIVE_PAYMENT_FORBIDDEN', testMessage);
  throw new AppError(status, 'TEST_PAYMENT_FORBIDDEN', `Live ${what} only.`);
}
