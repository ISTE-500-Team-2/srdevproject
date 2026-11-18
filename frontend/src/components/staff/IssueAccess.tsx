// Staff issue-membership/day-pass form combines plan, dates, payment details and an audit reason.
// B-003: it shows the member's own price (student or school-partner rates, as online) before
// staff take payment, and the server refuses to record a different one.

import { useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { cents, dollars, localInput, zonedDay } from "../../lib/display";
import { useApi } from "../../lib/useApi";
import type { Entitlement, Plan } from "../../lib/staffContracts";
import { ActionForm, Field, ReasonField } from "../Management";
import { PaymentMethod } from "./PaymentControls";

/** What the server will charge this member for the chosen plan and dates (GET …/entitlements/quote). */
interface DeskQuote {
  planId: number;
  standardCents: number;
  amountCents: number;
  basis: string;
}

/** Why the price differs from the plan's standard price. */
function priceReason(q: DeskQuote) {
  if (q.basis === "student") return `Student price (standard ${cents(q.standardCents)})`;
  if (q.basis === "school_partner") return "School partner free access: nothing to collect, it's recorded as waived";
  return "Standard price";
}

export function IssueAccess({
  id,
  plans,
  timeZone,
  renewal,
  disabled,
  onSaved,
}: {
  id: number;
  plans: Plan[];
  timeZone: string;
  renewal: Entitlement | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [planId, setPlanId] = useState(String(renewal?.planId ?? ""));
  const selected = plans.find((p) => p.id === Number(planId));
  const retry = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const renewalDate = renewal?.endsAt ? new Date(renewal.endsAt) : null;
  const startValue = renewalDate
    ? new Date(renewalDate.getTime() - renewalDate.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, -1)
    : localInput();
  const [startsAt, setStartsAt] = useState(startValue);
  const [validDate, setValidDate] = useState(zonedDay(timeZone));
  const startInstant = new Date(startsAt);
  const when =
    selected?.kind === "membership"
      ? Number.isNaN(startInstant.getTime()) ? null : `startsAt=${encodeURIComponent(startInstant.toISOString())}`
      : /^20\d{2}-\d{2}-\d{2}$/.test(validDate) ? `validDate=${validDate}` : null;
  const quote = useApi<DeskQuote>(
    selected && when ? `/admin/users/${id}/entitlements/quote?planId=${selected.id}&${when}` : null,
    { retainOnChange: true },
  );
  // Only a price for exactly these choices is promised to the server.
  const price = quote.data && !quote.stale && !quote.refreshing && quote.data.planId === selected?.id ? quote.data : null;
  return (
    <ActionForm
      title="Record external payment or waive payment"
      submitLabel="Record payment and issue access"
      disabled={disabled}
      onSubmit={async (f) => {
        if (!selected)
          throw new ApiError(400, "INVALID_INPUT", "Choose an active plan.");
        const body = {
          planId: selected.id,
          startsAt:
            selected.kind === "membership"
              ? new Date(String(f.get("startsAt"))).toISOString()
              : null,
          validDate:
            selected.kind === "day_pass" ? String(f.get("validDate")) : null,
          paymentStatus: f.get("paymentStatus"),
          method: f.get("method"),
          reference: f.get("reference"),
          reason: f.get("reason"),
          ...(price ? { expectedAmountCents: price.amountCents } : {}),
        };
        const fingerprint = JSON.stringify(body);
        if (retry.current?.fingerprint !== fingerprint)
          retry.current = { fingerprint, requestId: crypto.randomUUID() };
        await api(`/admin/users/${id}/entitlements`, {
          method: "POST",
          body: { ...body, requestId: retry.current.requestId },
        });
        retry.current = null;
        onSaved();
      }}
    >
      <Field label="Access plan" name="planId">
        <select
          name="planId"
          required
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
        >
          <option value="">Choose a plan</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {dollars(p.price)}
            </option>
          ))}
        </select>
      </Field>
      {selected?.kind === "membership" ? (
        <>
          <Field label="Membership starts (your local timezone)" name="startsAt">
            <input
              name="startsAt"
              type="datetime-local"
              step="0.001"
              required
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <p>
            Ends after {selected.months} calendar month(s). Existing overlapping
            active/suspended memberships are rejected.
          </p>
        </>
      ) : selected ? (
        <Field label={`Pass valid date (${timeZone})`} name="validDate">
          <input name="validDate" type="date" required value={validDate} onChange={(e) => setValidDate(e.target.value)} />
        </Field>
      ) : null}
      {selected ? (
        <p className="issue-access__price" aria-live="polite">
          {price ? (
            <>
              <strong>Price for this member: {cents(price.amountCents)}</strong> · {priceReason(price)}
            </>
          ) : quote.error ? (
            `Couldn't load this member's price (${quote.error}). It's worked out again when you save.`
          ) : (
            "Working out this member's price…"
          )}
        </p>
      ) : null}
      <Field label="Payment received or waived" name="paymentStatus">
        <select name="paymentStatus">
          <option value="paid">Paid externally</option>
          <option value="waived">Waived (zero amount)</option>
        </select>
      </Field>
      <PaymentMethod value="cash" />
      <Field
        label="External receipt/reference (no card details)"
        name="reference"
        required={false}
        maxLength={100}
      />
      <ReasonField />
      <p>
        Use this only for payment already collected outside this app or an approved
        waiver. It issues dated access without charging Stripe. Required waivers and training still apply.
      </p>
    </ActionForm>
  );
}
