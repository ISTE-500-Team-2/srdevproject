import { useState } from "react";
import type { Studio } from "../../lib/studioContracts";

export function StudioConfig({
  studio: s,
  busy,
  save,
}: {
  studio: Studio;
  busy: boolean;
  save: (body: unknown) => Promise<void>;
}) {
  const [rate, setRate] = useState(String((s.monthly_cents ?? 0) / 100)),
    [p, setP] = useState(s.cancellation_policy ?? "no_refunds"),
    [confirmed, setConfirmed] = useState(false);
  return (
    <details>
      <summary>Edit rate and terms</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            monthlyCents: Math.round(Number(rate) * 100),
            cancellationPolicy: p,
            policyConfirmed: confirmed,
            revision: s.revision,
          });
        }}
      >
        <label>
          Monthly rate (USD)
          <input
            type="number"
            min="0.50"
            max="100000"
            step="0.01"
            required
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </label>
        <label>
          Cancellation policy
          <select value={p} onChange={(e) => setP(e.target.value)}>
            <option value="no_refunds">No refunds</option>
            <option value="full_before_start">
              Full refund before start; none after
            </option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            required
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          These rates and terms are approved by The Collaboratory.
        </label>
        <button className="button button--primary" disabled={busy || !confirmed}>
          Save studio terms
        </button>
      </form>
    </details>
  );
}
