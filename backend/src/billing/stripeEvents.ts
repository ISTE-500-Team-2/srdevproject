import type Stripe from "stripe";

/** A Stripe refund event; its object is the refund. */
export type RefundEvent = Extract<
  Stripe.Event,
  { type: "refund.created" | "refund.updated" | "refund.failed" }
>;
/** Any Stripe Checkout Session event; its object is the session. */
export type CheckoutSessionEvent = Extract<Stripe.Event, { type: `checkout.session.${string}` }>;
/** Any Stripe subscription event; its object is the subscription. */
export type SubscriptionEvent = Extract<Stripe.Event, { type: `customer.subscription.${string}` }>;
/** Any Stripe invoice event; its object is the invoice. */
export type InvoiceEvent = Extract<Stripe.Event, { type: `invoice.${string}` }>;

const refundEventTypes: readonly string[] = ["refund.created", "refund.updated", "refund.failed"];

export const isRefundEvent = (event: Stripe.Event): event is RefundEvent =>
  refundEventTypes.includes(event.type);
export const isCheckoutSessionEvent = (event: Stripe.Event): event is CheckoutSessionEvent =>
  event.type.startsWith("checkout.session.");
export const isSubscriptionEvent = (event: Stripe.Event): event is SubscriptionEvent =>
  event.type.startsWith("customer.subscription.");
export const isInvoiceEvent = (event: Stripe.Event): event is InvoiceEvent =>
  event.type.startsWith("invoice.");
