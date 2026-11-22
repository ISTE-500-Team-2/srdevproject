// Shared Stripe adapter for checkout and refunds. It runs in test mode unless STRIPE_MODE=live, and
// refuses a key that does not belong to its mode.

import Stripe from "stripe";
import { lastRentalDay } from "./domain.js";
import type { StudioCheckoutRental, StudioRefundRental } from "./rows.js";
import { assertStripeMode, keyMatchesMode, readStripeMode, type StripeMode } from "../stripeMode.js";
export interface StudioStripeConfig {
  key: string;
  webhookSecret: string;
  origin: string;
  /** Omitted means test. */
  mode?: StripeMode;
}
export function readStudioStripeConfig(): StudioStripeConfig | undefined {
  // Validated even with Stripe disabled, so a mistyped mode never waits for a key to be added.
  const mode = readStripeMode();
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) return undefined;
  if (!keyMatchesMode(key, mode))
    throw new Error(mode === "live"
      ? "STRIPE_MODE=live only accepts a Stripe live key (sk_live_ or rk_live_)"
      : "Studio checkout only accepts a Stripe test key");
  const webhookSecret = process.env.STRIPE_STUDIO_WEBHOOK_SECRET;
  const origin = process.env.APP_ORIGIN;
  if (!webhookSecret?.startsWith("whsec_") || !origin)
    throw new Error("Stripe studio webhook secret and APP_ORIGIN required");
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Stripe return origin");
  return { key, webhookSecret, origin: url.origin, mode };
}
export class StudioStripe {
  readonly sdk: Stripe;
  readonly mode: StripeMode;
  constructor(readonly config: StudioStripeConfig) {
    this.mode = config.mode ?? "test";
    if (!keyMatchesMode(config.key, this.mode)) throw new Error(this.mode === "live" ? "Live keys only" : "Test keys only");
    this.sdk = new Stripe(config.key, { maxNetworkRetries: 2, timeout: 10000 });
  }
  async checkout(r: StudioCheckoutRental) {
    const expiresAt = Math.floor(new Date(r.hold_until).getTime() / 1000);
    const session = await this.sdk.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ['card'],
        integration_identifier: "arbor-studios-qmrxnpta",
        client_reference_id: String(r.id),
        metadata: { studioRentalId: String(r.id) },
        payment_intent_data: { metadata: { studioRentalId: String(r.id) } },
        expires_at: expiresAt,
        success_url: this.config.origin + `/studios?payment=returned&rental=${r.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: this.config.origin + "/studios?payment=cancelled",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: r.amount_cents,
              product_data: {
                name: `Studio rental ${r.starts_on} to ${lastRentalDay(r.ends_on)}`,
              },
            },
          },
        ],
      },
      // One key per hold window: a retry in the same window replays the same session, while a hold
      // given a fresh window (its first checkout never opened) is not refused as a changed request.
      { idempotencyKey: `studio-checkout:${r.id}:${expiresAt}` },
    );
    assertStripeMode(this.mode, session.livemode, "payments", { status: 503, testMessage: "Live payments are disabled." });
    return session;
  }
  async refund(r: StudioRefundRental) {
    // Only cancelled card rentals that were paid (so carry their payment intent) are refunded.
    const paymentIntent = r.payment_intent as string;
    // Reconcile an ambiguous earlier response even after Stripe's idempotency cache expires.
    const prior = await this.sdk.refunds.list({
      payment_intent: paymentIntent,
      limit: 100,
    });
    // A staff dashboard refund may omit our metadata. The provider list is scoped
    // to this rental's original payment intent; only its full quoted refund counts.
    const recovered = prior.data.find(f => f.status === "succeeded" && f.currency === "usd" && f.amount === r.refund_cents);
    if (recovered) return {...recovered, metadata: {...recovered.metadata, studioRentalId: String(r.id)}};
    const matching = prior.data.find(
      (f) =>
        f.metadata?.studioRentalId === String(r.id) &&
        f.amount === r.refund_cents,
    );
    if (matching) return matching;
    return this.sdk.refunds.create(
      {
        payment_intent: paymentIntent,
        amount: r.refund_cents,
        metadata: { studioRentalId: String(r.id) },
      },
      { idempotencyKey: `studio-refund:${r.id}` },
    );
  }
}
