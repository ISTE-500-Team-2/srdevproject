// The profile page's section frame and its read and edit pieces, shared by every section.

import { Check, Pencil, type LucideIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/api";

/** A problem found before anything is sent, worded for the member. SectionForm shows it as is. */
export class FormMessage extends Error {}

export function Section({
  id,
  title,
  note,
  Icon,
  action,
  editing,
  children,
}: {
  id: string;
  title: string;
  note: string;
  Icon: LucideIcon;
  action?: ReactNode;
  editing?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`account-section${editing ? " account-section--editing" : ""}`} aria-labelledby={`${id}-title`}>
      <header className="account-section__head">
        <span className="account-section__icon">
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{note}</p>
        </div>
        {action}
      </header>
      <div className="account-section__body">{children}</div>
    </section>
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="account-detail">
      <dt>{label}</dt>
      <dd>{children || <span className="account-detail__empty">Not added</span>}</dd>
    </div>
  );
}

export function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="button button--quiet account-edit" onClick={onClick} aria-label={label}>
      <Pencil aria-hidden="true" /> Edit
    </button>
  );
}

/** A form that saves one section and reports its own errors. */
export function SectionForm({
  onSave,
  onCancel,
  saveLabel,
  children,
}: {
  onSave: (form: FormData) => Promise<void>;
  onCancel: () => void;
  saveLabel: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(new FormData(event.currentTarget));
    } catch (err) {
      setError(err instanceof FormMessage ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form" onSubmit={(e) => void submit(e)}>
      {children}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="account-form__actions">
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          <Check aria-hidden="true" /> {busy ? "Saving…" : saveLabel}
        </button>
      </div>
    </form>
  );
}
