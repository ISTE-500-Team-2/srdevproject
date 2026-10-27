import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "./Management";
import { dollars, dateTime } from "../lib/display";
import type { Offer, BillingPass } from "../lib/billingContracts";
export function PassBilling() {
  const [date, setDate] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const offers = useApi<Offer[]>(
    "/me/billing/offers" + (date ? "?date=" + encodeURIComponent(date) : ""),
  );
  // Payment confirmations arrive from checkout and the front desk; keep current.
  const passes = useApi<BillingPass[]>("/me/billing/passes", { retainOnReload: true, refreshInterval: 15000 });
  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{
        checkoutUrl?: string;
        refundStatus?: string;
        manualRefundRequired?: boolean;
      }>(path, { method: "POST", body });
      if (r.checkoutUrl) {
        window.location.assign(r.checkoutUrl);
        return;
      }
      passes.reload();
      offers.reload();
      setMessage(
        r.manualRefundRequired
          ? "Pass cancelled. Contact staff to complete the original cash/card refund; it has not been refunded yet."
          : r.refundStatus && r.refundStatus !== "succeeded"
            ? "Refund requested; awaiting confirmation."
            : "Access records updated.",
      );
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel management-panel">
      <h2>Day passes and eligible free access</h2>
      <LoadState {...offers} />
      <p>
        Day passes cover one calendar day in the studio timezone. Cancellation
        requires 3 days’ notice before that day begins. Later cancellations aren't refunded.
      </p>
      <label className="pass-date">
        Visit date
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {!date && (
        <p className="pass-date__hint">Pick a visit date to buy a day pass.</p>
      )}
      {offers.data
        ?.filter((p) => p.kind === "day_pass")
        .map((p) => (
          <p key={p.id}>
            <button
              className="button button--primary"
              disabled={busy || !date}
              onClick={() =>
                act("/me/billing/passes/checkout", {
                  planId: p.id,
                  expectedRevision: p.revision,
                  pricingRevision: p.pricingRevision,
                  amountCents: p.amountCents,
                  validDate: date,
                })
              }
            >
              {p.amountCents === 0 ? "Claim" : "Buy"} {p.name} —{" "}
              {dollars((p.amountCents / 100).toFixed(2))}
              {p.basis !== "standard"
                ? " (verified " + p.basis.replace("_", " ") + ")"
                : ""}
            </button>
          </p>
        ))}
      {offers.data
        ?.filter((p) => p.kind === "membership" && p.amountCents === 0)
        .map((p) => (
          <p key={p.id}>
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() =>
                act("/me/billing/free-membership", {
                  planId: p.id,
                  expectedRevision: p.revision,
                  pricingRevision: p.pricingRevision,
                })
              }
            >
              Claim {p.name} — free for one month, no automatic renewal
            </button>
          </p>
        ))}
      <LoadState {...passes} />
      {passes.data?.map((p) => (
        <article className="management-record" key={p.id}>
          <strong>
            {p.plan?.name ?? "Day pass"} · {p.validDate}
          </strong>
          <p>
            {p.status}
            {p.refundStatus ? " · refund " + p.refundStatus : ""}. Cancel by{" "}
            {dateTime(p.cancelBy)}.
          </p>
          {!["cancelled", "expired"].includes(p.status) && (
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() => act("/me/billing/passes/" + p.id + "/cancel")}
            >
              {p.status === "pending"
                ? "Cancel checkout"
                : "Cancel day pass / retry refund"}
            </button>
          )}
        </article>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
