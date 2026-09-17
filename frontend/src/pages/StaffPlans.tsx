import { useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Plan } from "../lib/staffContracts";
import {
  ActionForm,
  Field,
  LoadState,
  ReasonField,
  dollars,
} from "../components/Management";

export function StaffPlans() {
  const plans = useApi<Plan[]>("/admin/plans");
  const [editing, setEditing] = useState<Plan | null>(null),
    [revision, setRevision] = useState(0);
  return (
    <section className="management-grid">
      <div>
        <h2>Membership and day-pass plans</h2>
        <p>
          Changes affect future issuance. Existing members keep their issued
          plan details.
        </p>
        <LoadState {...plans} />
        <div className="management-records">
          {plans.data?.map((plan) => (
            <article className="management-record" key={plan.id}>
              <h3>{plan.name}</h3>
              <p>
                {plan.kind === "membership"
                  ? `${plan.months} calendar month(s)`
                  : "One calendar day"}{" "}
                · {dollars(plan.price)} · {plan.active ? "Active" : "Archived"}
              </p>
              <p>{plan.benefits || "No benefits listed."}</p>
              <button
                className="button button--quiet"
                onClick={() => setEditing(plan)}
              >
                Edit {plan.name}
              </button>
            </article>
          ))}
        </div>
      </div>
      <div className="panel management-panel">
        <PlanEditor
          key={`${editing?.id ?? "new"}-${editing?.revision ?? revision}`}
          plan={editing}
          onSaved={() => {
            setEditing(null);
            setRevision((v) => v + 1);
            plans.reload();
          }}
        />
        {editing ? (
          <button className="text-button" onClick={() => setEditing(null)}>
            Cancel editing
          </button>
        ) : null}
      </div>
    </section>
  );
}
function PlanEditor({
  plan,
  onSaved,
}: {
  plan: Plan | null;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(plan?.kind ?? "membership");
  return (
    <ActionForm
      title={plan ? "Edit plan" : "Create a plan"}
      submitLabel={plan ? "Save plan" : "Create plan"}
      onSubmit={async (f) => {
        await api(plan ? `/admin/plans/${plan.id}` : "/admin/plans", {
          method: plan ? "PATCH" : "POST",
          body: {
            name: f.get("name"),
            kind,
            price: f.get("price"),
            months: kind === "membership" ? Number(f.get("months")) : null,
            benefits: f.get("benefits"),
            active: f.get("active") === "on",
            reason: f.get("reason"),
            ...(plan ? { revision: plan.revision } : {}),
          },
        });
        onSaved();
      }}
    >
      <Field
        label="Plan name"
        name="name"
        defaultValue={plan?.name}
        maxLength={50}
      />
      <Field label="Plan kind" name="kind">
        <select
          value={kind}
          disabled={!!plan}
          onChange={(e) => setKind(e.target.value as Plan["kind"])}
        >
          <option value="membership">Membership</option>
          <option value="day_pass">Day pass</option>
        </select>
      </Field>
      <Field
        label="Price (USD)"
        name="price"
        type="number"
        min="0"
        step="0.01"
        defaultValue={plan?.price ?? "0.00"}
      />
      {kind === "membership" ? (
        <Field
          label="Duration (calendar months)"
          name="months"
          type="number"
          min="1"
          step="1"
          defaultValue={plan?.months ?? 1}
        />
      ) : (
        <p>Valid for one calendar day in the makerspace timezone.</p>
      )}
      <Field label="Benefits" name="benefits">
        <textarea
          name="benefits"
          defaultValue={plan?.benefits ?? ""}
          maxLength={4000}
        />
      </Field>
      <label className="management-checkbox">
        <input
          type="checkbox"
          name="active"
          defaultChecked={plan?.active ?? true}
        />{" "}
        Available for new issuance
      </label>
      <ReasonField />
    </ActionForm>
  );
}
