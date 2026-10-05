import type { Billing, Offer } from "../lib/billingContracts";
import { useState } from "react";
import { useApi } from "../lib/useApi";
import { api, errorMessage } from "../lib/api";
import { LoadState } from "./Management";
import { dollars } from "../lib/display";

export function MembershipBilling() {
  const offers = useApi<Offer[]>("/me/billing/offers");
  const eligiblePlans = (offers.data ?? []).filter(
    (p) =>
      p.kind === "membership" &&
      p.months === 1 &&
      p.active &&
      p.amountCents >= 50 &&
      p.amountCents <= 10000000,
  );
  const state = useApi<{ enabled: boolean; records: Billing[] }>("/me/billing");
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ checkoutUrl?: string; url?: string }>(path, {
        method: "POST",
        body,
      });
      const url = result.checkoutUrl ?? result.url;
      if (url) {
        window.location.assign(url);
        return;
      }
      state.reload();
      setMessage(
        "Cancellation requested. Check the effective date below; billing continues through the 30-day notice period.",
      );
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel management-panel">
      <h2>Monthly card membership</h2>
      <LoadState {...state} />
      {state.data?.enabled ? (
        <>
          <p>
            Test payments only. No real money is charged. Membership starts only
            after payment is verified.
          </p>
          {state.data.records
            .filter(
              (r) =>
                !["canceled", "expired", "incomplete_expired"].includes(
                  r.status,
                ),
            )
            .map((r) => (
              <article className="management-record" key={r.id}>
                <h3>{r.plan.name}</h3>
                <p>
                  {dollars((r.amountCents / 100).toFixed(2))} per month ·{" "}
                  {r.status}
                </p>
                <p>
                  Auto-renew:{" "}
                  {r.cancellationEffectiveAt
                    ? r.cancellationConfirmed
                      ? "Cancellation scheduled"
                      : "Cancellation awaiting confirmation"
                    : r.cancelAtPeriodEnd
                      ? "Off"
                      : "On"}
                  .{" "}
                  {r.currentPeriodEnd &&
                    `Current billing period ends ${new Date(r.currentPeriodEnd).toLocaleDateString()}.`}
                </p>
                <p>
                  {r.cancellationEffectiveAt &&
                    `${r.cancellationConfirmed ? "Cancellation takes effect" : "Requested cancellation date"} ${new Date(r.cancellationEffectiveAt).toLocaleString()}.`}
                </p>
                <button
                  className="button button--quiet"
                  disabled={
                    busy || r.cancelAtPeriodEnd || !!r.cancellationConfirmed
                  }
                  onClick={() => act(`/me/billing/${r.id}/cancel`)}
                >
                  {r.status === "pending"
                    ? "Cancel checkout"
                    : r.cancellationEffectiveAt && !r.cancellationConfirmed
                      ? "Retry cancellation"
                      : "Stop automatic renewal"}
                </button>
                {r.status !== "pending" && (
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => act(`/me/billing/${r.id}/portal`)}
                  >
                    Manage payment method
                  </button>
                )}
              </article>
            ))}
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            I agree to the displayed monthly amount being charged automatically
            each month until cancellation takes effect. Cancellation requires 30
            days’ notice and takes effect at the next full monthly billing
            boundary after that notice.
          </label>
          {eligiblePlans.length === 0 && (
            <p>No monthly card rate is available. Contact staff.</p>
          )}
          {eligiblePlans.map((p) => (
            <p key={p.id}>
              <button
                className="button button--quiet"
                disabled={busy || !consent}
                onClick={() =>
                  act("/me/billing/checkout", {
                    planId: p.id,
                    expectedRevision: p.revision,
                    autoRenewConsent: true,
                    pricingRevision: p.pricingRevision,
                    amountCents: p.amountCents,
                  })
                }
              >
                Continue with {p.name} —{" "}
                {dollars((p.amountCents / 100).toFixed(2))}/month
              </button>
            </p>
          ))}
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => {
              state.reload();
              offers.reload();
            }}
          >
            Refresh payment status
          </button>
        </>
      ) : (
        state.data && (
          <p>
            Online membership checkout is not configured. Contact staff for
            membership or cash/card payment recording.
          </p>
        )
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
