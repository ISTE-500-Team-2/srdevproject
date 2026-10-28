import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import type { Audit, Entitlement, Page, Payment } from "../lib/staffContracts";

import { accessReasonLabel } from "../lib/accessReadiness";
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
  const [search,setSearch]=useState(''),[showSystem,setShowSystem]=useState(false);
  const system=(a:Audit)=>/\.(insert|update|delete)$/.test(a.action)&&!['app_device_access_event','check_in'].includes(a.entityType);
  const describe=(a:Audit)=>{
    if(a.entityType==='app_device_access_event')return {title:a.allowed===false?'Card tap denied':a.allowed===true?'Check-in allowed':'Card scanned',tone:a.allowed===false?'denied':a.allowed===true?'allowed':'neutral',badge:a.allowed===false?'Denied':a.allowed===true?'Allowed':'Scan'};
    const titles:Record<string,string>={'user.access_suspended':'Access suspended','user.access_restored':'Access restored','user.access_revoked':'Access revoked','user.account_suspended':'Account suspended','access.card_reassigned':'NFC card reassigned','access.card_assigned':'NFC card assigned','access.card_revoked':'NFC card revoked','member.demo_account_created':'Demo account created','owner.admin_account_created':'Administrator account created','policy.published':'Policy published','policy.retired':'Policy retired','user.insert':'Account created','user.update':'Account updated','user_role.insert':'Role assigned','check_in.insert':'Check-in recorded'};
    return {title:titles[a.action]??a.action.replace(/^app_/,'').replaceAll(/[._]/g,' ').replace(/^\w/,c=>c.toUpperCase()),tone:a.action.includes('suspend')||a.action.includes('revok')?'denied':'neutral',badge:system(a)?'System':'Updated'};
  };

  const visible=items.filter(a=>(showSystem||!system(a))&&[describe(a).title,a.subjectName,a.actorName,a.resourceName,a.accessReason,a.reason].join(' ').toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="activity-log">
      <div className="activity-toolbar">
        <label className="activity-search"><span>Search activity</span><input type="search" placeholder="Search names, actions or equipment…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <label className="activity-system"><input type="checkbox" checked={showSystem} onChange={e=>setShowSystem(e.target.checked)}/> Show system details</label>
      </div>
      <p className="activity-count">{visible.length} {visible.length===1?'event':'events'}{!showSystem&&items.some(system)?` · ${items.filter(system).length} background changes hidden`:''}</p>
      <div className="activity-feed">
      {visible.map(a=>{const info=describe(a);return <article className="activity-row" key={a.id}>
        <span className={`activity-marker is-${info.tone}`} aria-hidden="true">{info.tone==='denied'?'×':info.tone==='allowed'?'✓':'•'}</span>
        <div className="activity-content">
          <div className="activity-title"><h3>{info.title}</h3><span className={`activity-badge is-${info.tone}`}>{info.badge}</span></div>
          {a.subjectName||a.resourceName?<p className="activity-context">{[a.subjectName,a.resourceName].filter(Boolean).join(' · ')}</p>:null}
          {a.accessReason?<p className="activity-reason">{accessReasonLabel(a.accessReason)}</p>:a.reason&&a.reason!=='Database change'?<p className="activity-reason">{a.reason}</p>:null}
          <p className="activity-byline">{a.actorName==='System'?'Automatic reader / system event':`By ${a.actorName}`}</p>
          <details className="activity-details"><summary>Technical details</summary><dl><dt>Event</dt><dd>{a.action}</dd><dt>Record</dt><dd>{a.entityType} #{a.entityId}</dd>{a.readerId?<><dt>Reader</dt><dd>{a.readerId}</dd></>:null}<dt>Audit ID</dt><dd>{a.id}</dd></dl></details>
        </div>
        <time className="activity-time" dateTime={a.createdAt}>{dateTime(a.createdAt)}</time>
      </article>})}
      {!visible.length?<p className="activity-empty">{items.length?'No activity matches these filters.':'No activity recorded yet.'}</p>:null}
      </div>
    </div>
  );
}
