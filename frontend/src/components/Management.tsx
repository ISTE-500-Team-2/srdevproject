import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import type { Entitlement } from "../lib/staffContracts";

import { dateTime, dollars } from "../lib/display";

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
export function ReasonField({ label = "Reason for change" }: { label?: string }) {
  return <Field label={label} name="reason" maxLength={255} />;
}
export function ActionForm({
  title,
  submitLabel,
  onSubmit,
  children,
  disabled = false,
  submitDisabled = false,
  danger = false,
}: {
  title: string;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void>;
  children: ReactNode;
  disabled?: boolean;
  submitDisabled?: boolean;
  /** For actions that move money or can't be undone. */
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled || submitDisabled) return;
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
        <button className={`button ${danger ? "button--danger-action" : "button--primary"}`} type="submit" disabled={submitDisabled}>
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
          {error} <button type="button" onClick={reload}>Retry</button>
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
  // Everything fits on one page: no pager, and no made-up record range.
  if (offset === 0 && nextOffset == null) return null;
  return (
    <div className="management-actions management-pager">
      <button
        className="button button--quiet"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 50))}
      >
        Previous page
      </button>
      <span>Page {Math.floor(offset / 50) + 1}</span>
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
