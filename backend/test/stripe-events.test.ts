import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import {
  isCheckoutSessionEvent,
  isInvoiceEvent,
  isRefundEvent,
  isSubscriptionEvent,
} from "../src/billing/stripeEvents.js";

test("Stripe event guards match the event-type checks the webhooks used before", () => {
  const types = [
    "refund.created", "refund.updated", "refund.failed", "charge.refunded", "charge.refund.updated",
    "checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_failed",
    "customer.subscription.updated", "customer.subscription.deleted", "customer.updated",
    "invoice.paid", "invoice.upcoming", "invoice.payment_failed", "invoiceitem.created", "invoice_payment.paid",
  ];
  for (const type of types) {
    const event = { type } as Stripe.Event;
    assert.equal(isRefundEvent(event), ["refund.created", "refund.updated", "refund.failed"].includes(type), type);
    assert.equal(isCheckoutSessionEvent(event), type.startsWith("checkout.session."), type);
    assert.equal(isSubscriptionEvent(event), type.startsWith("customer.subscription."), type);
    assert.equal(isInvoiceEvent(event), type.startsWith("invoice."), type);
  }
});
