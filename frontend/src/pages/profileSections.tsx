// The profile page's section frame and its read and edit pieces, shared by every section.

import { Check, Pencil, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
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
          {/* Focusable so the section menu can move keyboard focus here (jumpToSection). */}
          <h2 id={`${id}-title`} tabIndex={-1}>
            {title}
          </h2>
          <p>{note}</p>
        </div>
        {action}
      </header>
      <div className="account-section__body">{children}</div>
    </section>
  );
}

/** `empty` replaces "Not added" while the value is still loading or couldn't be loaded. */
export function Detail({ label, empty = "Not added", children }: { label: string; empty?: string; children: ReactNode }) {
  return (
    <div className="account-detail">
      <dt>{label}</dt>
      <dd>{children || <span className="account-detail__empty">{empty}</span>}</dd>
    </div>
  );
}

export function EditButton({ label, onClick, ref }: { label: string; onClick: () => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button ref={ref} type="button" className="button button--quiet account-edit" onClick={onClick} aria-label={label}>
      <Pencil aria-hidden="true" /> Edit
    </button>
  );
}

/**
 * The button that opens a section's form disappears while the form is open. Attach the
 * returned ref to it: when the form closes and takes keyboard focus with it, focus goes
 * back to the button instead of falling to the top of the page.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    // Only when focus was lost with the form; never pull it from wherever the person went next.
    if (closed && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus();
  }, [open]);
  return opener;
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
  const form = useRef<HTMLFormElement>(null);
  // The button that opened this form is gone now: start keyboard focus at the first field.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus();
  }, []);
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
    <form ref={form} className="account-form" onSubmit={(e) => void submit(e)}>
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
