// Shared payment editing/refund actions; provider refunds and externally recorded payments use
// different workflows.

import { api } from "../../lib/api";
import { dollars, type StatusTone } from "../../lib/display";
import type { Payment } from "../../lib/staffContracts";
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
/** What a card payment's Stripe refund is doing, if one was asked for and hasn't finished. */
export function refundNote(payment: Payment) {
  if (payment.refundStatus === "pending" || payment.refundStatus === "requires_action") return "Refund pending";
  // The app reuses an invoice's existing Stripe refund, so a failed one needs sorting out in Stripe.
  if (payment.refundStatus === "failed" || payment.refundStatus === "canceled") return "Refund failed";
  return null;
}

/**
 * Why a pending payment has no desk action: its equipment booking is still in online card
 * checkout, which settles it. Null for every other payment.
 */
export function checkoutNote(payment: Payment) {
  return payment.onlineCheckout && payment.status === "pending"
    ? "Not paid yet: the member pays through online card checkout. To release the booking, open the account that booked it with View as and choose Cancel checkout on the Equipment page."
    : null;
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
export function paymentAction(payment: Payment): "update" | "refund" | null {
  if (payment.method === "card") {
    // Only before any refund was asked for: a failed one can't be retried from here (see refundNote).
    return cardRefundPath(payment) && payment.status === "paid" && !payment.refundStatus ? "refund" : null;
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
  if (payment.passCheckoutId) return "The day pass is cancelled once the refund goes through.";
  if (payment.equipmentReservationId)
    return "The booking itself doesn't change. If it shouldn't go ahead, cancel it separately.";
  return "Their membership and access stay as they are.";
}

/** Sends a card payment back to the card it came from, after an explicit confirmation. */
export function CardRefund({
  payment,
  onRefunded,
}: {
  payment: Payment;
  onRefunded: (status: string) => void;
}) {
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
        The full payment goes back to the card it was paid with. {refundEffect(payment)} Stripe is in test mode, so no
        real money moves.
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
