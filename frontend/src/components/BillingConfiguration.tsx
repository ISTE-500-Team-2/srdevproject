import type { EligibilityPrice } from "../lib/billingContracts";
import { useApi } from "../lib/useApi";
import { api } from "../lib/api";
import { ActionForm, Field, ReasonField, LoadState } from "./Management";
import type { Plan } from "../lib/staffContracts";
export function BillingConfiguration({ plans }: { plans: Plan[] }) {
  const prices = useApi<EligibilityPrice[]>("/billing-management/pricing");
  return (
    <div className="panel management-panel">
      <h2>Verified discounts and school-partner access</h2>
      <p>
        Enter approved rates only. Student eligibility uses the staff-managed
        Student classification. School-partner access needs a staff verification
        reference and expiry date; users cannot self-approve.
      </p>
      <LoadState {...prices} />
      {prices.data &&
        plans.map((p) => {
          const current = prices.data?.find((r) => r.tierid === p.id);
          return (
            <ActionForm
              key={p.id + ":" + (current?.revision ?? 0)}
              title={p.name + " eligibility pricing"}
              submitLabel="Save eligibility pricing"
              onSubmit={async (f) => {
                const value = String(f.get("student") ?? "");
                await api("/billing-management/pricing/" + p.id, {
                  method: "PATCH",
                  body: {
                    studentCents:
                      value === "" ? null : Math.round(Number(value) * 100),
                    partnerFree: f.get("partner") === "on",
                    revision: current?.revision ?? 0,
                    reason: f.get("reason"),
                  },
                });
                prices.reload();
              }}
            >
              <Field
                label="Student price (USD; blank means standard rate)"
                name="student"
                type="number"
                min="0"
                step="0.01"
                required={false}
                defaultValue={
                  current?.student_cents == null
                    ? ""
                    : (current.student_cents / 100).toFixed(2)
                }
              />
              <label>
                <input
                  name="partner"
                  type="checkbox"
                  defaultChecked={current?.partner_free ?? false}
                />{" "}
                Approved school partners receive free access
              </label>
              <ReasonField />
            </ActionForm>
          );
        })}
      <ActionForm
        title="Verify school-partner eligibility"
        submitLabel="Save verification"
        onSubmit={async (f) => {
          await api("/billing-management/partner/" + Number(f.get("userId")), {
            method: "POST",
            body: {
              reference: f.get("reference"),
              validUntil: f.get("validUntil"),
            },
          });
        }}
      >
        <Field name="userId" label="Member ID" type="number" min="1" />
        <Field
          name="reference"
          label="Approved school and verification reference"
        />
        <Field
          name="validUntil"
          label="Eligible through (set a past date to revoke)"
          type="date"
        />
      </ActionForm>
    </div>
  );
}
