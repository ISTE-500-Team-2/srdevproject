import Stripe from "stripe";
import { AppError } from "../domain.js";
export interface StudioStripeConfig {
  key: string;
  webhookSecret: string;
  origin: string;
}
export function readStudioStripeConfig(): StudioStripeConfig | undefined {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) return undefined;
  if (!key.startsWith("sk_test_"))
    throw new Error("Studio checkout only accepts a Stripe test key");
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
  return { key, webhookSecret, origin: url.origin };
}
export class StudioStripe {
  readonly sdk: Stripe;
  constructor(readonly config: StudioStripeConfig) {
    if (!config.key.startsWith("sk_test_")) throw new Error("Test keys only");
    this.sdk = new Stripe(config.key, { maxNetworkRetries: 2, timeout: 10000 });
  }
  async checkout(r: any) {
    const session = await this.sdk.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: String(r.id),
        metadata: { studioRentalId: String(r.id) },
        payment_intent_data: { metadata: { studioRentalId: String(r.id) } },
        expires_at: Math.floor(new Date(r.hold_until).getTime() / 1000),
        success_url: this.config.origin + "/studios?payment=returned",
        cancel_url: this.config.origin + "/studios?payment=cancelled",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: r.amount_cents,
              product_data: {
                name: `Studio rental ${r.starts_on} to ${r.ends_on}`,
              },
            },
          },
        ],
      },
      { idempotencyKey: `studio-checkout:${r.id}` },
    );
    if (session.livemode)
      throw new AppError(
        503,
        "LIVE_PAYMENT_FORBIDDEN",
        "Live payments are disabled.",
      );
    return session;
  }
  async refund(r: any) {
    // Reconcile an ambiguous earlier response even after Stripe's idempotency cache expires.
    const prior = await this.sdk.refunds.list({
      payment_intent: r.payment_intent,
      limit: 100,
    });
    const matching = prior.data.find(
      (f) =>
        f.metadata?.studioRentalId === String(r.id) &&
        f.amount === r.refund_cents,
    );
    if (matching) return matching;
    return this.sdk.refunds.create(
      {
        payment_intent: r.payment_intent,
        amount: r.refund_cents,
        metadata: { studioRentalId: String(r.id) },
      },
      { idempotencyKey: `studio-refund:${r.id}` },
    );
  }
}
