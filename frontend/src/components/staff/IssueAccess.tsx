import { useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { dollars, localInput, zonedDay } from "../../lib/display";
import type { Entitlement, Plan } from "../../lib/staffContracts";
import { ActionForm, Field, ReasonField } from "../Management";
import { PaymentMethod } from "./PaymentControls";

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
  return (
    <ActionForm
      title="Issue membership or day pass"
      submitLabel="Issue access"
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
          <Field
            label="Membership starts (your local timezone)"
            name="startsAt"
            type="datetime-local"
            step="0.001"
            defaultValue={startValue}
          />
          <p>
            Ends after {selected.months} calendar month(s). Existing overlapping
            active/suspended memberships are rejected.
          </p>
        </>
      ) : selected ? (
        <Field
          label={`Pass valid date (${timeZone})`}
          name="validDate"
          type="date"
          defaultValue={zonedDay(timeZone)}
        />
      ) : null}
      <Field label="Initial payment record" name="paymentStatus">
        <select name="paymentStatus">
          <option value="pending">Pending</option>
          <option value="paid">Paid externally</option>
          <option value="waived">Waived (zero amount)</option>
        </select>
      </Field>
      <PaymentMethod />
      <Field
        label="External receipt/reference (no card details)"
        name="reference"
        required={false}
        maxLength={100}
      />
      <ReasonField />
      <p>
        This grants dated access and records the plan price. It does not collect
        payment or bypass signed-policy requirements.
      </p>
    </ActionForm>
  );
}
