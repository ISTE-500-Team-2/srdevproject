import { refundTransition } from "../billing/refundTransition.js";

/** Rental payment states that record an original-card refund. */
export type StudioRefundState = "refund_pending" | "refund_failed" | "refunded";

// Studios store a refund's outcome in payment_status; the shared decision works
// on Stripe refund statuses.
const providerStatus: Record<StudioRefundState, string> = {
  refund_pending: "pending",
  refund_failed: "failed",
  refunded: "succeeded",
};
const isRefundState = (status: string): status is StudioRefundState =>
  Object.hasOwn(providerStatus, status);

/** The rental payment state a Stripe refund status is recorded as. */
export function studioRefundState(status: string | null): StudioRefundState {
  if (status === "succeeded") return "refunded";
  return ["failed", "canceled"].includes(status ?? "") ? "refund_failed" : "refund_pending";
}

/**
 * Decides whether a Stripe refund update applies to a cancelled rental, using
 * the shared refund transition after mapping both sides to the three studio
 * states (so `canceled` counts as failed and other statuses as pending).
 */
export function studioRefundDecision(
  rental: { paymentStatus: string; refundId: string | null },
  refund: { id: string; status: string | null },
): "skip" | "apply" {
  // Only a rental already awaiting or holding a refund outcome can change.
  if (!isRefundState(rental.paymentStatus)) return "skip";
  const next = studioRefundState(refund.status);
  // Studios never let a pending refund reopen a recorded failure, even when it
  // is a different refund; staff reconcile failed studio refunds in Stripe.
  if (rental.paymentStatus === "refund_failed" && next === "refund_pending") return "skip";
  return refundTransition(
    { refundId: rental.refundId, refundStatus: providerStatus[rental.paymentStatus] },
    { id: refund.id, status: providerStatus[next] },
  );
}
