import { useState } from "react";
import type { Rental } from "../../lib/studioContracts";
import { money, rentalRange } from "../../lib/studioDisplay";

export function StaffRental({
  rental: r,
  busy,
  perform,
}: {
  rental: Rental;
  busy: boolean;
  perform: (path: string, body: unknown) => Promise<void>;
}) {
  const [ref, setRef] = useState("");
  const payable = r.status === "pending" && r.payment_method === "manual",
    refundable =
      r.payment_method === "manual" && r.payment_status === "refund_pending";
  return (
    <article className="studio-card">
      <h3>
        {r.name} <small>#{r.id}</small>
      </h3>
      <p>
        {r.email} · {rentalRange(r.starts_on, r.ends_on)} ·{" "}
        {money(r.amount_cents)}
      </p>
      <p>
        {payable
          ? "Waiting for payment at the front desk."
          : refundable
            ? `Refund ${money(r.refund_cents)} by the original payment method, then record it here.`
            : r.payment_method === "stripe_test"
              ? "Card refund needs attention."
              : ""}
      </p>
      {(payable || refundable) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(
              `/studio-management/rentals/${r.id}/${payable ? "payment" : "refund"}`,
              { reference: ref },
            );
          }}
        >
          <label>
            {payable
              ? "Receipt/reference for payment received"
              : "Original-method refund reference"}
            <input
              minLength={3}
              maxLength={200}
              required
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </label>
          <button className="button button--primary" disabled={busy}>
            {payable
              ? "Record received payment"
              : `Record completed ${money(r.refund_cents)} refund`}
          </button>
        </form>
      )}
      {r.payment_method === "stripe_test" &&
        ["refund_pending", "refund_failed"].includes(r.payment_status) && (
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() =>
              void perform(
                `/studio-management/rentals/${r.id}/retry-refund`,
                {},
              )
            }
          >
            {r.refund_id && r.payment_status === "refund_failed"
              ? "Recheck refund after Stripe reconciliation"
              : "Retry test card refund"}
          </button>
        )}
    </article>
  );
}
