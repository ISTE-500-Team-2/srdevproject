import "./plans.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, GraduationCap, Plus, School, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Plan } from "../lib/staffContracts";
import type { EligibilityPrice } from "../lib/billingContracts";
import { ActionForm, Field, LoadState } from "../components/Management";
import { MemberSelect } from "../components/MemberSelect";
import { cents, dollars } from "../lib/display";

type Selection = { mode: "new" } | { mode: "edit"; id: number } | null;

const period = (plan: Pick<Plan, "kind" | "months">) =>
  plan.kind === "day_pass" ? "day" : plan.months === 1 ? "month" : `${plan.months} months`;

const firstBenefit = (benefits: string) =>
  benefits.split(/\r?\n/).map((line) => line.replace(/^[-*•]\s*/, "").trim()).find(Boolean) ?? "";

export function StaffPlans() {
  const { user } = useAuth();
  // Student and school-partner rates are admin-only on the server.
  const isAdmin = !!user?.roles.includes("admin");
  const plans = useApi<Plan[]>("/admin/plans", { retainOnReload: true });
  const prices = useApi<EligibilityPrice[]>(isAdmin ? "/billing-management/pricing" : null, { retainOnReload: true });
  const [selected, setSelected] = useState<Selection>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState("");
  const all = plans.data ?? [];
  const live = all.filter((p) => p.active);
  const archived = all.filter((p) => !p.active);
  const editing = selected?.mode === "edit" ? all.find((p) => p.id === selected.id) ?? null : null;
  const priceFor = (id: number) => prices.data?.find((row) => row.tierid === id);
  const open = (next: Selection) => {
    setNotice("");
    setSelected(next);
  };
  const rowProps = {
    isAdmin,
    selectedId: editing?.id ?? null,
    priceFor,
    onOpen: (plan: Plan) => open({ mode: "edit", id: plan.id }),
  };
  return (
    <div className="plans">
      <header className="plans-head">
        <p>
          What members can buy. Changes apply to new purchases; anyone who already
          bought a plan keeps the price and terms they paid for.
        </p>
        <button className="button button--primary plans-new" onClick={() => open({ mode: "new" })}>
          <Plus aria-hidden="true" /> New plan
        </button>
      </header>
      {notice && !selected ? (
        <p role="status" className="plans-notice">
          {notice}
        </p>
      ) : null}
      <LoadState {...plans} />
      <LoadState {...prices} />
      <div className={`plans-layout${selected ? " plans-layout--editing" : ""}`}>
        <div className="plans-main">
          {plans.data ? (
            <>
              <PlanGroup
                title="Memberships"
                empty="No memberships are on sale."
                plans={live.filter((p) => p.kind === "membership")}
                {...rowProps}
              />
              <PlanGroup
                title="Day passes"
                empty="No day passes are on sale."
                plans={live.filter((p) => p.kind === "day_pass")}
                {...rowProps}
              />
              {archived.length ? (
                <div className="plans-archived">
                  <button
                    className="plans-archived__toggle"
                    aria-expanded={showArchived}
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    <ChevronDown aria-hidden="true" />
                    Off sale <span className="plans-count">{archived.length}</span>
                  </button>
                  {showArchived ? <PlanGroup title="Off sale" hideTitle plans={archived} {...rowProps} /> : null}
                </div>
              ) : null}
            </>
          ) : null}
          <SchoolPartners />
        </div>
        {selected && (selected.mode === "new" || editing) ? (
          <PlanEditor
            key={editing ? `${editing.id}-${editing.revision}-${priceFor(editing.id)?.revision ?? 0}` : "new"}
            plan={editing}
            price={editing ? priceFor(editing.id) : undefined}
            isAdmin={isAdmin}
            notice={notice}
            onClose={() => open(null)}
            onSaved={(saved, problem) => {
              plans.reload();
              prices.reload();
              if (problem) {
                // The plan itself saved; keep it open so the discount can be retried.
                setSelected({ mode: "edit", id: saved.id });
                setNotice(problem);
              } else {
                setSelected(null);
                setNotice(`Saved ${saved.name}.`);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function PlanGroup({
  title,
  hideTitle = false,
  empty,
  plans,
  isAdmin,
  selectedId,
  priceFor,
  onOpen,
}: {
  title: string;
  hideTitle?: boolean;
  empty?: string;
  plans: Plan[];
  isAdmin: boolean;
  selectedId: number | null;
  priceFor: (id: number) => EligibilityPrice | undefined;
  onOpen: (plan: Plan) => void;
}) {
  return (
    <section className="plans-group" aria-label={title}>
      {hideTitle ? null : (
        <div className="plans-group__head">
          <h2>{title}</h2>
          <span className="plans-count">{plans.length}</span>
        </div>
      )}
      {plans.length ? (
        <ul className="plans-list">
          {plans.map((plan) => {
            const price = priceFor(plan.id);
            const benefit = firstBenefit(plan.benefits);
            return (
              <li
                key={plan.id}
                className={`plans-row${plan.id === selectedId ? " is-selected" : ""}${plan.active ? "" : " is-off-sale"}`}
              >
                <div className="plans-row__name">
                  <h3>
                    <button
                      className="plans-row__open"
                      aria-current={plan.id === selectedId ? "true" : undefined}
                      onClick={() => onOpen(plan)}
                    >
                      {plan.name}
                    </button>
                  </h3>
                  {benefit ? <p>{benefit}</p> : <p className="plans-muted">No benefits listed</p>}
                </div>
                <div className="plans-row__price">
                  <strong>{dollars(plan.price)}</strong>
                  <span>/ {period(plan)}</span>
                </div>
                {isAdmin ? (
                  <div className="plans-row__discounts">
                    {price?.student_cents != null ? (
                      <span className="plans-chip">
                        <GraduationCap aria-hidden="true" /> Students {cents(price.student_cents)}
                      </span>
                    ) : null}
                    {price?.partner_free ? (
                      <span className="plans-chip">
                        <School aria-hidden="true" /> Partners free
                      </span>
                    ) : null}
                    {price?.student_cents == null && !price?.partner_free ? (
                      <span className="plans-muted">No discounts</span>
                    ) : null}
                  </div>
                ) : null}
                <ChevronRight className="plans-row__chevron" aria-hidden="true" />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="plans-empty">{empty}</p>
      )}
    </section>
  );
}

function PlanEditor({
  plan,
  price,
  isAdmin,
  notice,
  onClose,
  onSaved,
}: {
  plan: Plan | null;
  price: EligibilityPrice | undefined;
  isAdmin: boolean;
  notice: string;
  onClose: () => void;
  onSaved: (plan: Plan, problem?: string) => void;
}) {
  const [kind, setKind] = useState<Plan["kind"]>(plan?.kind ?? "membership");
  const [active, setActive] = useState(plan?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    // On narrow screens the editor sits above the list; bring it into view.
    if (window.matchMedia?.("(max-width: 1180px)").matches)
      panel.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);
  const title = plan ? `Edit ${plan.name}` : "Create a plan";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const f = new FormData(event.currentTarget);
    const reason = String(f.get("reason") ?? "");
    const body = {
      name: String(f.get("name") ?? ""),
      kind,
      price: String(f.get("price") ?? ""),
      months: kind === "membership" ? Number(f.get("months")) : null,
      benefits: String(f.get("benefits") ?? ""),
      active,
    };
    const planChanged =
      !plan ||
      body.name !== plan.name ||
      Number(body.price) !== Number(plan.price) ||
      body.months !== plan.months ||
      body.benefits !== plan.benefits ||
      body.active !== plan.active;
    const studentText = String(f.get("student") ?? "").trim();
    const studentCents = studentText === "" ? null : Math.round(Number(studentText) * 100);
    const partnerFree = f.get("partner") === "on";
    const discountChanged =
      isAdmin &&
      (studentCents !== (price?.student_cents ?? null) || partnerFree !== (price?.partner_free ?? false));
    if (!planChanged && !discountChanged) {
      setError("Nothing has changed.");
      return;
    }
    setBusy(true);
    setError("");
    let saved: Plan | null = plan;
    try {
      if (planChanged) {
        saved = await api<Plan>(plan ? `/admin/plans/${plan.id}` : "/admin/plans", {
          method: plan ? "PATCH" : "POST",
          body: { ...body, reason, ...(plan ? { revision: plan.revision } : {}) },
        });
      }
      if (discountChanged && saved) {
        await api(`/billing-management/pricing/${saved.id}`, {
          method: "PATCH",
          body: { studentCents, partnerFree, revision: price?.revision ?? 0, reason },
        });
      }
      onSaved(saved!);
    } catch (err) {
      if (planChanged && saved && saved !== plan) {
        const problem = `${saved.name} was saved, but its discounts weren't: ${errorMessage(err)}`;
        // Shown now, and again by the fresh editor once the saved plan reloads.
        setError(problem);
        onSaved(saved, problem);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      ref={panel}
      className="plans-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <form onSubmit={submit} aria-label={title}>
        <div className="plans-editor__head">
          <h2>{plan ? plan.name : "New plan"}</h2>
          <button type="button" className="plans-icon-button" aria-label="Close editor" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <fieldset disabled={busy} className="plans-editor__body">
          <div className="plans-field">
            <span className="plans-label" id="plan-kind-label">
              Plan type
            </span>
            {plan ? (
              <p className="plans-static">
                {plan.kind === "membership" ? "Membership" : "Day pass"}
                <span className="plans-hint">The type can't change after a plan is created.</span>
              </p>
            ) : (
              <div className="segmented plans-kind" role="radiogroup" aria-labelledby="plan-kind-label">
                {(["membership", "day_pass"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={kind === value}
                    className={kind === value ? "is-selected" : ""}
                    onClick={() => setKind(value)}
                  >
                    {value === "membership" ? "Membership" : "Day pass"}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="plans-field">
            <label className="plans-label" htmlFor="plan-name">
              Plan name
            </label>
            <input id="plan-name" name="name" defaultValue={plan?.name ?? ""} required maxLength={50} autoFocus={!plan} />
          </div>

          <div className="plans-pair">
            <div className="plans-field">
              <label className="plans-label" htmlFor="plan-price">
                Price (USD)
              </label>
              <span className="plans-affix">
                <span aria-hidden="true">$</span>
                <input
                  id="plan-price"
                  name="price"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  defaultValue={plan?.price ?? "0.00"}
                />
              </span>
            </div>
            {kind === "membership" ? (
              <div className="plans-field">
                <label className="plans-label" htmlFor="plan-months">
                  Length (calendar months)
                </label>
                <input id="plan-months" name="months" type="number" min="1" max="120" step="1" required defaultValue={plan?.months ?? 1} />
              </div>
            ) : (
              <div className="plans-field">
                <span className="plans-label">Length</span>
                <p className="plans-static">One calendar day</p>
              </div>
            )}
          </div>

          <div className="plans-field">
            <label className="plans-label" htmlFor="plan-benefits">
              Benefits
            </label>
            <textarea
              id="plan-benefits"
              name="benefits"
              rows={4}
              maxLength={4000}
              aria-describedby="plan-benefits-hint"
              defaultValue={plan?.benefits ?? ""}
            />
            <p className="plans-hint" id="plan-benefits-hint">
              One per line. Members see each line as a bullet on the membership page.
            </p>
          </div>

          {isAdmin ? (
            <div className="plans-section">
              <h3>Discounts</h3>
              <div className="plans-field">
                <label className="plans-label" htmlFor="plan-student">
                  Student price (USD)
                </label>
                <span className="plans-affix">
                  <span aria-hidden="true">$</span>
                  <input
                    id="plan-student"
                    aria-describedby="plan-student-hint"
                    name="student"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={price?.student_cents == null ? "" : (price.student_cents / 100).toFixed(2)}
                  />
                </span>
                <p className="plans-hint" id="plan-student-hint">
                  Leave blank to charge students the full price.
                </p>
              </div>
              <div className="plans-option">
                <label className="plans-check">
                  <input
                    name="partner"
                    type="checkbox"
                    aria-describedby="plan-partner-hint"
                    defaultChecked={price?.partner_free ?? false}
                  />
                  Free for verified school partners
                </label>
                <p className="plans-hint" id="plan-partner-hint">
                  Verify members under School partners below.
                </p>
              </div>
            </div>
          ) : null}

          <div className="plans-section">
            <h3>Availability</h3>
            <div className="plans-option plans-option--switch">
              <label className="plans-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-describedby="plan-active-hint"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                <span className="plans-switch__track" aria-hidden="true" />
                On sale
              </label>
              <p className="plans-hint" id="plan-active-hint">
                {active ? "Members can buy this plan." : "Hidden from members. Anyone who already has it keeps it."}
              </p>
            </div>
          </div>

          <div className="plans-field">
            <label className="plans-label" htmlFor="plan-reason">
              Reason for change
            </label>
            <input id="plan-reason" name="reason" required maxLength={255} aria-describedby="plan-reason-hint" />
            <p className="plans-hint" id="plan-reason-hint">
              Saved to the change log.
            </p>
          </div>

          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <div className="plans-editor__actions">
            <button className="button button--primary" type="submit">
              {busy ? "Saving…" : plan ? "Save plan" : "Create plan"}
            </button>
            <button type="button" className="button button--quiet" onClick={onClose}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </aside>
  );
}

function SchoolPartners() {
  return (
    <section className="plans-group plans-partners" aria-label="School partners">
      <div className="plans-group__head">
        <h2>School partners</h2>
      </div>
      <p className="plans-partners__intro">
        Verify a member through a partner school. Plans marked free for school partners cost them
        nothing through the date you set. Set a past date to revoke.
      </p>
      <ActionForm
        title="Verify school-partner eligibility"
        submitLabel="Save verification"
        onSubmit={async (f) => {
          await api("/billing-management/partner/" + Number(f.get("userId")), {
            method: "POST",
            body: { reference: f.get("reference"), validUntil: f.get("validUntil") },
          });
        }}
      >
        <MemberSelect name="userId" />
        <Field name="reference" label="School and verification reference" />
        <Field name="validUntil" label="Eligible through" type="date" />
      </ActionForm>
    </section>
  );
}
