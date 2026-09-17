import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import type { Audit, Entitlement, Page, Payment } from "../lib/staffContracts";

export function localInput(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function zonedDay(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export const dollars = (value: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(value),
  );
export const dateTime = (value?: string) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
export function Field({
  label,
  name,
  defaultValue = "",
  type = "text",
  required = true,
  maxLength = 255,
  min,
  step,
  children,
}: {
  label: string;
  name: string;
  defaultValue?: string | number;
  type?: string;
  required?: boolean;
  maxLength?: number;
  min?: string;
  step?: string;
  children?: ReactNode;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children ?? (
        <input
          name={name}
          type={type}
          defaultValue={defaultValue}
          required={required}
          maxLength={maxLength}
          min={min}
          step={step}
        />
      )}
    </label>
  );
}
export function ReasonField() {
  return <Field label="Reason for change" name="reason" maxLength={255} />;
}
export function ActionForm({
  title,
  submitLabel,
  onSubmit,
  children,
  disabled = false,
}: {
  title: string;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void>;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      await onSubmit(form);
      setSuccess(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="management-form" aria-label={title}>
      <h3>{title}</h3>
      <fieldset disabled={busy || disabled}>
        {children}
        <button className="button button--primary" type="submit">
          {busy ? "Saving…" : submitLabel}
        </button>
      </fieldset>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {success ? <p role="status">Saved.</p> : null}
    </form>
  );
}
export function LoadState({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error: string;
  reload: () => void;
}) {
  return (
    <>
      {loading ? <p role="status">Loading records…</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {error} <button onClick={reload}>Retry</button>
        </p>
      ) : null}
    </>
  );
}
export function Pager({
  offset,
  nextOffset,
  onChange,
}: {
  offset: number;
  nextOffset: number | null;
  onChange: (n: number) => void;
}) {
  return (
    <div className="management-actions">
      <button
        className="button button--quiet"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 50))}
      >
        Previous page
      </button>
      <span>
        Records {offset + 1}–{offset + 50}
      </span>
      <button
        className="button button--quiet"
        disabled={nextOffset == null}
        onClick={() => nextOffset != null && onChange(nextOffset)}
      >
        Next page
      </button>
    </div>
  );
}
export function EntitlementList({
  memberships,
  passes,
  actions,
}: {
  memberships: Entitlement[];
  passes: Entitlement[];
  actions?: (item: Entitlement, kind: "membership" | "day_pass") => ReactNode;
}) {
  const entries = [
    ...memberships.map((item) => ({ item, kind: "membership" as const })),
    ...passes.map((item) => ({ item, kind: "day_pass" as const })),
  ];
  return (
    <div className="management-records">
      {entries.length ? (
        entries.map(({ item, kind }) => (
          <article className="management-record" key={`${kind}-${item.id}`}>
            <div>
              <h3>
                {item.plan?.name ??
                  (kind === "membership" ? "Membership" : "Day pass")}{" "}
                <small>#{item.id}</small>
              </h3>
              <span className="status-label">{item.effectiveStatus}</span>
            </div>
            <p>
              {kind === "membership"
                ? `${dateTime(item.startsAt)} → ${dateTime(item.endsAt)}`
                : `Valid calendar date: ${item.validDate}`}
            </p>
            {item.plan?.benefits ? <p>{item.plan.benefits}</p> : null}
            {item.plan?.price ? (
              <p>Issued plan price: {dollars(item.plan.price)}</p>
            ) : null}
            {actions?.(item, kind)}
          </article>
        ))
      ) : (
        <p>No memberships or day passes have been issued.</p>
      )}
    </div>
  );
}
export function PaymentList({
  page,
  actions,
}: {
  page: Page<Payment>;
  actions?: (p: Payment) => ReactNode;
}) {
  return (
    <div className="management-records">
      {page.items.length ? (
        page.items.map((p) => (
          <article className="management-record" key={p.id}>
            <div>
              <h3>
                Payment #{p.id} · {p.memberName}
              </h3>
              <strong>{dollars(p.amount)}</strong>
            </div>
            <p>
              {p.planName} · <span className="status-label">{p.status}</span> ·{" "}
              {p.method.replaceAll("_", " ")}
            </p>
            <p>
              Recorded {dateTime(p.recordedAt)}
              {p.reference ? ` · Reference: ${p.reference}` : ""}
            </p>
            {actions?.(p)}
          </article>
        ))
      ) : (
        <p>No payment records.</p>
      )}
    </div>
  );
}
export function AuditList({ items }: { items: Audit[] }) {
  return (
    <div className="management-records">
      {items.length ? (
        items.map((a) => (
          <details className="management-record" key={a.id}>
            <summary>
              {a.action} · {a.entityType} #{a.entityId} · {a.actorName} ·{" "}
              {dateTime(a.createdAt)}
            </summary>
            <p>{a.reason}</p>
            <pre>
              {JSON.stringify({ before: a.before, after: a.after }, null, 2)}
            </pre>
          </details>
        ))
      ) : (
        <p>No staff changes recorded.</p>
      )}
    </div>
  );
}
