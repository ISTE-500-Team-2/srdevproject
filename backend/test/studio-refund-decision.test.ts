import assert from "node:assert/strict";
import { test } from "node:test";
import { studioRefundDecision, studioRefundState } from "../src/studios/refundDecision.js";

// The conditional UPDATE studios used before the shared decision, restricted to
// rows that already matched the rental, payment intent and refund amount.
function oldSqlPredicate(paymentStatus: string, refundId: string | null, id: string, status: string | null) {
  const next = status === "succeeded" ? "refunded" : ["failed", "canceled"].includes(status ?? "") ? "refund_failed" : "refund_pending";
  return (
    (["refund_pending", "refund_failed"].includes(paymentStatus) ||
      (paymentStatus === "refunded" && refundId !== null && refundId === id && next === "refund_failed")) &&
    !(paymentStatus === "refund_failed" && next === "refund_pending") &&
    (paymentStatus !== next || refundId !== id)
  );
}

const paymentStatuses = ["unpaid", "paid", "refund_pending", "refund_failed", "refunded"];
const recordedIds = [null, "re_a", "re_b"];
const incomingIds = ["re_a", "re_b"];
const providerStatuses = ["succeeded", "failed", "canceled", "pending", "requires_action", null];

test("studio refund decision matches the previous SQL predicate for every state", () => {
  let cases = 0;
  for (const paymentStatus of paymentStatuses)
    for (const refundId of recordedIds)
      for (const id of incomingIds)
        for (const status of providerStatuses) {
          const expected = oldSqlPredicate(paymentStatus, refundId, id, status) ? "apply" : "skip";
          assert.equal(
            studioRefundDecision({ paymentStatus, refundId }, { id, status }),
            expected,
            JSON.stringify({ paymentStatus, refundId, id, status }),
          );
          cases++;
        }
  assert.equal(cases, 180);
});

test("studio refund decision keeps stale and out-of-order provider events from rewriting state", () => {
  const decide = (paymentStatus: string, refundId: string | null, id: string, status: string | null) =>
    studioRefundDecision({ paymentStatus, refundId }, { id, status });
  // Stale success after the same refund failed.
  assert.equal(decide("refund_failed", "re_a", "re_a", "succeeded"), "apply");
  assert.equal(decide("refund_failed", "re_a", "re_a", "pending"), "skip");
  // A late failure of the recorded successful refund corrects it; another refund's failure does not.
  assert.equal(decide("refunded", "re_a", "re_a", "failed"), "apply");
  assert.equal(decide("refunded", "re_a", "re_b", "failed"), "skip");
  assert.equal(decide("refunded", "re_a", "re_a", "pending"), "skip");
  // Studio-only guard: a different refund's pending event never reopens a failure.
  assert.equal(decide("refund_failed", "re_a", "re_b", "pending"), "skip");
  assert.equal(decide("refund_failed", "re_a", "re_b", "requires_action"), "skip");
  // Statuses are mapped before deciding: canceled is a failure, requires_action is pending.
  assert.equal(decide("refund_failed", "re_a", "re_a", "canceled"), "skip");
  assert.equal(decide("refund_pending", "re_a", "re_a", "requires_action"), "skip");
  // Rentals not awaiting a refund are never touched.
  assert.equal(decide("paid", null, "re_a", "succeeded"), "skip");
  assert.equal(decide("refund_pending", null, "re_a", "succeeded"), "apply");
});

test("studio refund state maps Stripe statuses to the three rental refund states", () => {
  assert.equal(studioRefundState("succeeded"), "refunded");
  assert.equal(studioRefundState("failed"), "refund_failed");
  assert.equal(studioRefundState("canceled"), "refund_failed");
  assert.equal(studioRefundState("pending"), "refund_pending");
  assert.equal(studioRefundState("requires_action"), "refund_pending");
  assert.equal(studioRefundState(null), "refund_pending");
});
