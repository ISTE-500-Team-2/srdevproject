import { useState } from "react";
import type { Rental } from "../../lib/studioContracts";
import { dateOnly,money } from "../../lib/studioDisplay";

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
        Rental #{r.id}: {r.name}
      </h3>
      <p>
        {r.email} · {dateOnly(r.starts_on)} – {dateOnly(r.ends_on)} ·{" "}
        {money(r.amount_cents)}
      </p>
      <p>
        {r.status} / {r.payment_status} / {r.payment_method}
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
          <button className="button" disabled={busy}>
            {payable
              ? "Record received payment"
              : `Record completed ${money(r.refund_cents)} refund`}
          </button>
        </form>
      )}
      {r.payment_method === "stripe_test" &&
        ["refund_pending", "refund_failed"].includes(r.payment_status) && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void perform(
                `/studio-management/rentals/${r.id}/retry-refund`,
                {},
              )
            }
          >
            {r.refund_id && r.payment_status === "refund_failed" ? "Recheck refund after Stripe reconciliation" : "Retry test card refund"}
          </button>
        )}
    </article>
  );
}

