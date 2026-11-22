// Shared payment editing/refund actions; provider refunds and externally recorded payments use
// different workflows.

import { api } from "../../lib/api";
import { dollars, type StatusTone } from "../../lib/display";
import type { Payment } from "../../lib/staffContracts";
import { useStripeMode } from "../../lib/stripeMode";
import { ActionForm, Field, ReasonField } from "../Management";

const statusNames: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  void: "Void",
  waived: "Waived",
  refunded: "Refunded",
};
const methodNames: Record<string, string> = {
  unspecified: "Not recorded",
  cash: "Cash",
  external_card: "Card at desk",
  bank_transfer: "Bank transfer",
  other: "Other",
  card: "Card online",
  // $0 day passes and approved free memberships are recorded with method "none".
  none: "No charge",
};
/** Plain words for a payment's status, method and Stripe refund state. */
export const paymentStatusName = (status: string) => statusNames[status] ?? status;
export const paymentMethodName = (method: string) => methodNames[method] ?? method;
export function paymentStatusTone(status: string): StatusTone {
  if (status === "paid") return "ok";
  if (status === "pending") return "warn";
  return "neutral";
}
const failedRefund = (payment: Payment) => payment.refundStatus === "failed" || payment.refundStatus === "canceled";

/** What a card payment's Stripe refund is doing, if one was asked for and hasn't finished. */
export function refundNote(payment: Payment) {
  if (payment.refundStatus === "needs_review") return "Refund needs staff review";
  if (payment.refundStatus === "partial") return "Partially refunded";
  if (payment.refundStatus === "pending" || payment.refundStatus === "requires_action") return "Refund pending";
  // A failed membership invoice refund is sorted out in Stripe; a day pass's or booking's can be retried (see paymentAction).
  if (failedRefund(payment)) return "Refund failed";
  return null;
}

// Only whoever opened a booking's checkout can cancel it: the member, or the staff member who booked for them.
const openCheckoutNotes = {
  member:
    "Not paid yet: the member pays through online card checkout. To release the booking, open the account that booked it with View as and choose Cancel checkout on the Equipment page.",
  viewer:
    "Not paid yet: you opened an online card checkout for this booking. To release it, choose Cancel checkout under My reservations on the Equipment page.",
  staff:
    "Not paid yet: another staff member opened an online card checkout for this booking. They can release it with Cancel checkout on their Equipment page; an unpaid checkout also releases it when it expires.",
};

/**
 * Why a pending payment has no desk action: its equipment booking is still in online card
 * checkout, which settles it. Null for every other payment.
 */
export function checkoutNote(payment: Payment) {
  return payment.onlineCheckout && payment.status === "pending" ? openCheckoutNotes[payment.checkoutOpenedBy ?? "member"] : null;
}

/** Whether Stripe took a card refund, done or on its way. Any other status means no money went back. */
export const refundAccepted = (status: string) =>
  status === "succeeded" || status === "pending" || status === "requires_action";

// Status changes staff may record for each current status.
const transitions: Record<string, string[]> = {
  pending: ["paid", "void", "waived"],
  paid: ["refunded"],
};
const transitionNames: Record<string, string> = {
  paid: "Paid at the desk",
  void: "Void (no longer owed)",
  waived: "Waived (no charge)",
  refunded: "Refunded at the desk",
};

/** Where a card payment is refunded through Stripe: its membership invoice, day-pass checkout or equipment booking. */
export function cardRefundPath(payment: Payment) {
  if (payment.invoiceId) return `/billing-management/invoices/${encodeURIComponent(payment.invoiceId)}/refund`;
  if (payment.passCheckoutId) return `/billing-management/passes/${encodeURIComponent(payment.passCheckoutId)}/refund`;
  if (payment.equipmentReservationId) return `/billing-management/equipment/${payment.equipmentReservationId}/refund`;
  return null;
}

/** The one thing staff can do to this payment from the list, if anything. */
export function paymentAction(payment: Payment): "update" | "refund" | "review" | null {
  if (payment.method === "card") {
    if (payment.passCheckoutId && payment.refundStatus === "needs_review") return "review";
    if (!cardRefundPath(payment) || payment.status !== "paid") return null;
    if (!payment.refundStatus) return "refund";
    // A failed day-pass or booking refund returned nothing, and the server submits a new attempt, so staff can
    // retry it here: the member can't retry one staff started. A membership invoice's is sorted out in Stripe.
    return failedRefund(payment) && !payment.invoiceId ? "refund" : null;
  }
  // A booking's online checkout settles its payment: recording it at the desk would leave the open
  // checkout able to charge the member again. (Once paid by card, it is refunded through that booking above.)
  if (payment.onlineCheckout) return null;
  return transitions[payment.status]?.length ? "update" : null;
}

export function PaymentMethod({ value = "unspecified" }: { value?: string }) {
  return (
    <Field label="Payment method" name="method">
      <select name="method" defaultValue={value}>
        <option value="unspecified">Not received / not recorded</option>
        <option value="cash">Cash</option>
        <option value="external_card">Card at the desk (outside this app)</option>
        <option value="bank_transfer">Bank transfer</option>
        <option value="other">Other</option>
      </select>
    </Field>
  );
}

/** Records what happened at the front desk. Never charges or refunds a card. */
export function PaymentEditor({
  payment,
  onSaved,
}: {
  payment: Payment;
  onSaved: (status: string) => void;
}) {
  const options = transitions[payment.status] ?? [];
  return (
    <ActionForm
      title={`Update payment #${payment.id}`}
      submitLabel="Save"
      onSubmit={async (f) => {
        const status = String(f.get("status"));
        await api(`/admin/payments/${payment.id}/status`, {
          method: "POST",
          body: {
            status,
            method: f.get("method"),
            reference: f.get("reference"),
            reason: f.get("reason"),
            revision: payment.revision,
          },
        });
        onSaved(status);
      }}
    >
      <p>Record what happened at the desk. This doesn't charge or refund a card.</p>
      <div className="payment-editor__fields">
        <Field label="New status" name="status">
          <select name="status">
            {options.map((s) => (
              <option key={s} value={s}>
                {transitionNames[s] ?? s}
              </option>
            ))}
          </select>
        </Field>
        <PaymentMethod value={payment.method === "card" ? "unspecified" : payment.method} />
        <Field
          label="Receipt or reference (no card numbers)"
          name="reference"
          defaultValue={payment.reference}
          required={false}
          maxLength={100}
        />
        <ReasonField />
      </div>
    </ActionForm>
  );
}

/** What else a card refund changes, by what was paid for. */
function refundEffect(payment: Payment) {
  // A day-pass checkout that couldn't become a pass (for example, one bought for a date the member already
  // had a pass for) has no pass of its own, so the refund leaves any pass they hold alone.
  if (payment.passCheckoutId && !payment.dayPassId) return "No day pass was issued for this payment, so only the charge goes back.";
  if (payment.passCheckoutId) return "The day pass is cancelled once the refund goes through.";
  if (payment.equipmentReservationId)
    return "The booking itself doesn't change. If it shouldn't go ahead, cancel it separately.";
  return "Their membership and access stay as they are.";
}

/** Checks Stripe and records the staff decision without submitting a refund. */
export function RefundReview({ payment, onReviewed }: { payment: Payment; onReviewed: (message: string) => void }) {
  return (
    <ActionForm
      title={`Review refund for payment #${payment.id}`}
      submitLabel="Complete review"
      onSubmit={async (f) => {
        const result = await api<{ passIssued?: boolean; passCancelled?: boolean; passKept?: boolean }>(cardRefundPath(payment) ?? "", {
          method: "POST",
          body: { reason: f.get("reason"), review: true, ...(f.has("honorVisit") ? { honorVisit: true } : {}) },
        });
        const effect = result?.passCancelled ? "Day pass cancelled"
          : result?.passKept ? "Existing day pass kept as approved"
          : result?.passIssued ? "Day pass issued"
          : "Refund review completed";
        onReviewed(`${effect} for payment #${payment.id}.`);
      }}
    >
      <p>
        Check the visit record and Stripe before completing review. A confirmed full refund closes the day pass
        and marks the charge refunded. To keep a replacement pass issued during a release rollback, choose
        Honor the visit. To refund that replacement or return the rest of a partial refund, do so in Stripe
        before completing review. Wait for any pending refunds to finish.
      </p>
      {payment.passCheckoutId && (
        <label className="payment-editor__confirm">
          <input type="checkbox" name="honorVisit" />
          <span>Honor the visit. Keep the existing pass or issue an eligible held pass if Stripe confirms the full or remaining charge.</span>
        </label>
      )}
      <ReasonField label="Reason for closing review" />
    </ActionForm>
  );
}

/** Sends a card payment back to the card it came from, after an explicit confirmation. */
export function CardRefund({
  payment,
  onRefunded,
}: {
  payment: Payment;
  onRefunded: (status: string) => void;
}) {
  const testMode = useStripeMode() === "test";
  const amount = dollars(payment.amount);
  return (
    <ActionForm
      title={`Refund ${amount} to ${payment.memberName}'s card`}
      submitLabel={`Refund ${amount}`}
      danger
      onSubmit={async (f) => {
        const result = await api<{ status: string }>(cardRefundPath(payment) ?? "", {
          method: "POST",
          body: { reason: f.get("reason") },
        });
        onRefunded(result.status);
      }}
    >
      <p>
        The full payment goes back to the card it was paid with. {refundEffect(payment)}
        {testMode ? " Stripe is in test mode, so no real money moves." : null}
      </p>
      <div className="payment-editor__fields">
        <ReasonField label="Reason for refund" />
      </div>
      <label className="payment-editor__confirm">
        <input type="checkbox" name="confirm" required />
        <span>
          Refund {amount} to {payment.memberName}. This can't be undone.
        </span>
      </label>
    </ActionForm>
  );
}
