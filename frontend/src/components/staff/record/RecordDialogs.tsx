import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "../../../lib/api";
import { dollars } from "../../../lib/display";
import type { AccessResource, NfcCard, ReaderSetup } from "../../../lib/nfc";
import type { SupervisionSummary } from "../../../lib/contracts";
import type { Entitlement, Payment, Person, Plan } from "../../../lib/staffContracts";
import { useApi } from "../../../lib/useApi";
import { AssignCard } from "../../access/MemberCards";
import { MemberSelect } from "../../MemberSelect";
import { Modal } from "../../Modal";
import { AssistedPurchase } from "../AssistedPurchase";
import { CardRefund, PaymentEditor, paymentStatusName } from "../PaymentControls";
import { ROLES, roleName } from "./recordModel";

export type DialogState =
  | { kind: "status"; lift?: boolean }
  | { kind: "access"; restore?: boolean }
  | { kind: "roles" }
  | { kind: "conduct" }
  | { kind: "profile" }
  | { kind: "sell"; renewal?: Entitlement }
  | { kind: "entitlement"; item: Entitlement; entitlementKind: "membership" | "day_pass" }
  | { kind: "payment"; payment: Payment }
  | { kind: "refund"; payment: Payment }
  | { kind: "assign"; replacement?: NfcCard }
  | { kind: "card"; card: NfcCard; action: "revoke" | "reactivate" }
  | { kind: "supervise" }
  | { kind: "endSupervision"; override: { id: number; resourceName: string } }
  | { kind: "sponsor" };

/** Thrown when the record changed under an open dialog: the dialog stops offering a retry on old data. */
class StaleDialog extends Error {}

/** A compact dialog around one form. `onSubmit` returns the sentence the toast shows. */
function RecordDialog({
  title,
  submitLabel,
  danger = false,
  wide = false,
  submitDisabled = false,
  onClose,
  onSubmit,
  onDone,
  children,
}: {
  title: string;
  submitLabel: string;
  danger?: boolean;
  wide?: boolean;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => Promise<string>;
  onDone: (message: string) => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitDisabled || stale) return;
    setBusy(true);
    setError("");
    try {
      onDone(await onSubmit(new FormData(event.currentTarget)));
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof StaleDialog) setStale(true);
      setBusy(false);
    }
  };
  return (
    <Modal open width={wide ? "regular" : "compact"} title={title} onClose={() => !busy && onClose()} className="mr-dialog">
      {/* management-form: the record's background refresh waits while this is being edited. */}
      <form className="management-form mr-dialog__form" aria-label={title} onSubmit={submit}>
        <fieldset className="mr-dialog__fields" disabled={busy}>
          {children}
        </fieldset>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="mr-dialog__actions">
          <button className={`button ${danger ? "button--danger-action" : "button--primary"}`} type="submit" disabled={busy || submitDisabled || stale}>
            {busy ? "Saving…" : submitLabel}
          </button>
          <button className="button button--quiet" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Choice({ name, value, title, help, checked, tone }: { name: string; value: string; title: string; help: string; checked: boolean; tone?: "bad" }) {
  return (
    <label className="mr-option" data-tone={tone}>
      <input type="radio" name={name} value={value} defaultChecked={checked} required />
      <strong>{title}</strong>
      <small>{help}</small>
    </label>
  );
}
function Reason({ optional = false, label }: { optional?: boolean; label?: string }) {
  return (
    <label className="form-field">
      <span>
        {label ?? (optional ? "Note for the change log" : "Reason")}
        {optional ? <span className="mr-optional"> (optional)</span> : null}
      </span>
      <input name="reason" maxLength={255} minLength={3} required={!optional} placeholder={optional ? "" : "Saved to the change log"} />
    </label>
  );
}

export function RecordDialogHost({
  dialog,
  person,
  plans,
  timeZone,
  supervision,
  onClose,
  onDone,
  onPerson,
  onConflict,
}: {
  dialog: DialogState;
  person: Person;
  plans: Plan[];
  timeZone: string;
  supervision: SupervisionSummary | null;
  onClose: () => void;
  /** A change was saved: show this sentence and refresh the record. */
  onDone: (message: string) => void;
  /** A write returned the member's committed record, with its new revision. */
  onPerson: (person: Person) => void;
  /** Someone else saved first; refresh before the next try. */
  onConflict: () => void;
}) {
  const first = person.firstName;
  const id = person.id;
  const common = { onClose, onDone };
  const write = async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
    try {
      const saved = await api<Person>(path, { method, body: { ...body, revision: person.revision } });
      if (saved && typeof saved === "object" && "revision" in saved) onPerson(saved);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "STALE_RECORD") {
        onConflict();
        throw new Error("Someone else changed this account just now. The latest is loaded; check it and save again.");
      }
      throw error;
    }
  };

  switch (dialog.kind) {
    case "status":
      return (
        <RecordDialog
          {...common}
          title={dialog.lift ? (person.status === "inactive" ? "Reopen account" : "Lift the hold") : "Account status"}
          submitLabel={dialog.lift ? (person.status === "inactive" ? "Reopen account" : "Lift hold") : "Save status"}
          onSubmit={async (f) => {
            const status = String(f.get("status"));
            await write(`/admin/users/${id}/status`, "POST", { status, reason: f.get("reason") });
            return status === "active" ? `${first} can sign in and check in again.` : status === "suspended" ? `${first} is on hold.` : `${first}’s account is closed.`;
          }}
        >
          <p className="mr-dialog__lead">Controls whether {first} can sign in. Bookings and history are always kept.</p>
          <fieldset className="mr-options">
            <legend className="sr-only">Account status</legend>
            <Choice name="status" value="active" title="Active" help="Can sign in, book and check in." checked={dialog.lift || person.status === "active"} />
            <Choice name="status" value="suspended" title="On hold" help="Signed out everywhere and can’t sign in until you lift the hold." checked={!dialog.lift && person.status === "suspended"} tone="bad" />
            <Choice name="status" value="inactive" title="Closed" help="The account is closed. Signed out; records are kept." checked={!dialog.lift && person.status === "inactive"} tone="bad" />
          </fieldset>
          <Reason />
        </RecordDialog>
      );
    case "access":
      return (
        <RecordDialog
          {...common}
          title={dialog.restore ? "Restore facility access" : "Facility access"}
          submitLabel={dialog.restore ? "Restore access" : "Save access"}
          onSubmit={async (f) => {
            const status = String(f.get("status"));
            await write(`/admin/users/${id}/access`, "POST", { status, reason: f.get("reason") });
            return status === "active" ? `${first}’s facility access is restored.` : `${first}’s facility access is ${status}.`;
          }}
        >
          <p className="mr-dialog__lead">A staff restriction on the shop itself. {first} can still sign in and see their account.</p>
          <fieldset className="mr-options">
            <legend className="sr-only">Facility access</legend>
            <Choice name="status" value="active" title="No restriction" help="Membership, waiver and training rules decide access as usual." checked={dialog.restore || person.accessStatus === "active"} />
            <Choice name="status" value="suspended" title="Suspended" help="Readers, check-in and new bookings refuse them, and any open visit ends." checked={!dialog.restore && person.accessStatus === "suspended"} tone="bad" />
            <Choice name="status" value="revoked" title="Revoked" help="The same as suspended, recorded as permanent." checked={!dialog.restore && person.accessStatus === "revoked"} tone="bad" />
          </fieldset>
          <Reason />
        </RecordDialog>
      );
    case "roles":
      return <RolesDialog person={person} {...common} write={write} />;
    case "conduct":
      return (
        <RecordDialog
          {...common}
          title="Conduct flag"
          submitLabel="Save flag"
          onSubmit={async (f) => {
            const flagged = f.get("flagged") === "on";
            await write(`/admin/users/${id}/conduct`, "POST", { flagged, reason: f.get("reason") });
            return flagged ? `${first} is flagged for conduct.` : `${first}’s conduct flag is cleared.`;
          }}
        >
          <label className="mr-check">
            <input type="checkbox" name="flagged" defaultChecked={person.conductFlag} />
            <strong>Flag {first} for conduct</strong>
            <small>Staff see it on this record. It doesn’t block access by itself; use Facility access for that.</small>
          </label>
          <Reason />
        </RecordDialog>
      );
    case "profile":
      return (
        <RecordDialog
          {...common}
          title="Name & phone"
          submitLabel="Save"
          onSubmit={async (f) => {
            await write(`/admin/users/${id}/profile`, "PATCH", {
              firstName: f.get("firstName"),
              lastName: f.get("lastName"),
              phone: f.get("phone"),
              reason: String(f.get("reason") ?? "").trim() || undefined,
            });
            return "Name and phone saved.";
          }}
        >
          <div className="mr-grid2">
            <label className="form-field">
              <span>First name</span>
              <input name="firstName" defaultValue={person.firstName} required maxLength={50} autoComplete="off" />
            </label>
            <label className="form-field">
              <span>Last name</span>
              <input name="lastName" defaultValue={person.lastName} required maxLength={50} autoComplete="off" />
            </label>
          </div>
          <label className="form-field">
            <span>
              Phone<span className="mr-optional"> (optional)</span>
            </span>
            <input name="phone" type="tel" defaultValue={person.phone} maxLength={15} autoComplete="off" />
          </label>
          <p className="mr-dialog__hint">Email is how {first} signs in, so they change it from their own profile.</p>
          <Reason optional />
        </RecordDialog>
      );
    case "entitlement": {
      const item = dialog.item;
      const noun = dialog.entitlementKind === "membership" ? "membership" : "day pass";
      return (
        <RecordDialog
          {...common}
          title={`${item.plan?.name ?? (dialog.entitlementKind === "membership" ? "Membership" : "Day pass")} #${item.id}`}
          submitLabel="Save"
          onSubmit={async (f) => {
            const status = String(f.get("status"));
            try {
              await api(`/admin/users/${id}/entitlements/${dialog.entitlementKind}/${item.id}/status`, {
                method: "POST",
                body: { status, revision: item.revision, reason: f.get("reason") },
              });
            } catch (error) {
              if (error instanceof ApiError && error.status === 409) {
                onConflict();
                throw new StaleDialog(`This ${noun} changed since you opened it. The latest is loaded; close this and check it before trying again.`);
              }
              throw error;
            }
            return status === "active" ? `The ${noun} is active.` : status === "suspended" ? `The ${noun} is paused.` : `The ${noun} has ended.`;
          }}
        >
          <fieldset className="mr-options">
            <legend className="sr-only">{noun} status</legend>
            <Choice name="status" value="active" title="Active" help="Grants access until its end date." checked={item.status === "active"} />
            <Choice name="status" value="suspended" title="Paused" help="Doesn’t grant access until you make it active again." checked={item.status === "suspended"} />
            <Choice name="status" value="revoked" title="End it now" help={`Can’t be undone. Issue a new ${noun} to give access again.`} checked={false} tone="bad" />
          </fieldset>
          <Reason />
        </RecordDialog>
      );
    }
    case "sell":
      return (
        <Modal open width="regular" title={dialog.renewal ? `Renew ${dialog.renewal.plan?.name ?? "membership"}` : "Sell or record a payment"} onClose={onClose} className="mr-dialog">
          {dialog.renewal ? <p className="mr-dialog__lead">The renewal starts when the current membership ends, so no days overlap.</p> : null}
          <AssistedPurchase
            heading={false}
            id={id}
            plans={plans.filter((p) => p.active)}
            timeZone={timeZone}
            renewal={dialog.renewal ?? null}
            disabled={false}
            onSaved={() => onDone("Access issued and the payment recorded.")}
          />
        </Modal>
      );
    case "payment":
      return (
        <Modal open width="compact" title={`Payment #${dialog.payment.id}`} onClose={onClose} className="mr-dialog">
          <PaymentEditor payment={dialog.payment} onSaved={(status) => onDone(`Payment #${dialog.payment.id} marked ${paymentStatusName(status).toLowerCase()}.`)} />
        </Modal>
      );
    case "refund":
      return (
        <Modal open width="compact" title={`Refund ${dollars(dialog.payment.amount)}`} onClose={onClose} className="mr-dialog">
          <CardRefund payment={dialog.payment} onRefunded={(status) => onDone(status === "succeeded" ? `Refunded ${dollars(dialog.payment.amount)}.` : `Refund of ${dollars(dialog.payment.amount)} started.`)} />
        </Modal>
      );
    case "assign":
      return <AssignDialog person={person} replacement={dialog.replacement ?? null} onClose={onClose} onDone={onDone} />;
    case "card": {
      const card = dialog.card;
      const revoke = dialog.action === "revoke";
      return (
        <RecordDialog
          {...common}
          title={revoke ? `Revoke ${card.label}?` : `Reactivate ${card.label}?`}
          submitLabel={revoke ? "Revoke card" : "Reactivate card"}
          danger={revoke}
          onSubmit={async (f) => {
            try {
              await api(`/admin/access/cards/${card.id}/${dialog.action}`, {
                method: "POST",
                body: { expectedRevision: card.revision, reason: f.get("reason") },
              });
            } catch (error) {
              // Someone else changed this card: load the latest and have staff look before trying again.
              onConflict();
              if (error instanceof ApiError && error.status === 409)
                throw new StaleDialog("This card changed since you opened it. The latest is loaded; close this and check the card before trying again.");
              throw error;
            }
            return revoke ? `${card.label} revoked.` : `${card.label} reactivated.`;
          }}
        >
          <p className="mr-dialog__lead">
            {revoke
              ? `${card.label}${card.last4 ? ` (ending ${card.last4})` : ""} stops opening readers right away. You can reactivate it later.`
              : `${card.label} opens readers for ${first} again. Membership, waiver and training rules still apply.`}
          </p>
          <Reason />
        </RecordDialog>
      );
    }
    case "supervise":
      return <SuperviseDialog person={person} timeZone={timeZone} {...common} />;
    case "endSupervision":
      return (
        <RecordDialog
          {...common}
          title="End supervised use?"
          submitLabel="End it"
          onSubmit={async (f) => {
            await api(`/admin/access/overrides/${dialog.override.id}/revoke`, { method: "POST", body: { reason: f.get("reason") } });
            return `Supervised use of ${dialog.override.resourceName} ended.`;
          }}
        >
          <p className="mr-dialog__lead">This ends {first}’s supervised use of {dialog.override.resourceName} and cancels any booking made for it.</p>
          <Reason />
        </RecordDialog>
      );
    case "sponsor":
      return <SponsorDialog person={person} supervision={supervision} {...common} />;
  }
}

function RolesDialog({
  person,
  onClose,
  onDone,
  write,
}: {
  person: Person;
  onClose: () => void;
  onDone: (m: string) => void;
  write: (path: string, method: "POST" | "PATCH", body: Record<string, unknown>) => Promise<void>;
}) {
  const [checked, setChecked] = useState<string[]>(person.roles.filter((r) => ROLES.includes(r)));
  const [primary, setPrimary] = useState(person.primaryRole ?? checked[0] ?? "member");
  const toggle = (role: string, on: boolean) => {
    const next = on ? [...checked, role] : checked.filter((r) => r !== role);
    setChecked(next);
    if (!on && primary === role) setPrimary(next[0] ?? "");
    if (on && !next.includes(primary)) setPrimary(role);
  };
  return (
    <RecordDialog
      title="Roles"
      submitLabel="Save roles"
      submitDisabled={!checked.length || !checked.includes(primary)}
      onClose={onClose}
      onDone={onDone}
      onSubmit={async (f) => {
        await write(`/admin/users/${person.id}/role`, "POST", {
          primaryRole: primary,
          roles: ROLES.filter((r) => checked.includes(r)),
          isStudent: f.get("isStudent") === "on",
          reason: f.get("reason"),
        });
        return "Roles saved.";
      }}
    >
      <div className="mr-roles" role="group" aria-label="Roles">
        <div className="mr-roles__row mr-roles__row--head" aria-hidden="true">
          <span>Role</span>
          <span>Primary</span>
        </div>
        {ROLES.map((role) => (
          <div className="mr-roles__row" key={role}>
            <label>
              <input type="checkbox" checked={checked.includes(role)} onChange={(e) => toggle(role, e.target.checked)} />
              {roleName(role)}
            </label>
            <input
              type="radio"
              name="primary"
              aria-label={`Make ${roleName(role)} the primary role`}
              checked={primary === role}
              disabled={!checked.includes(role)}
              onChange={() => setPrimary(role)}
            />
          </div>
        ))}
      </div>
      <label className="mr-check">
        <input type="checkbox" name="isStudent" defaultChecked={!!person.isStudent} />
        <strong>Student</strong>
        <small>Unlocks student pricing. It isn’t a role.</small>
      </label>
      <Reason />
    </RecordDialog>
  );
}

function AssignDialog({ person, replacement, onClose, onDone }: { person: Person; replacement: NfcCard | null; onClose: () => void; onDone: (m: string) => void }) {
  const setup = useApi<ReaderSetup>("/admin/access/readers");
  const name = `${person.firstName} ${person.lastName}`;
  return (
    <Modal open width="regular" title={replacement ? `Replace ${replacement.label}` : "Assign an NFC card"} onClose={onClose} className="mr-dialog mr-dialog--scan">
      {replacement ? <p className="mr-dialog__lead">{replacement.label} keeps working until the new card is saved.</p> : null}
      {setup.error ? (
        <p role="alert" className="form-error">
          {setup.error}{" "}
          <button type="button" className="today-link" onClick={setup.reload}>
            Try again
          </button>
        </p>
      ) : setup.data ? (
        <AssignCard
          userId={person.id}
          memberName={name}
          setup={setup.data}
          replacement={replacement}
          onCancelReplacement={onClose}
          onSaved={() => onDone(replacement ? `New card assigned. ${replacement.label} revoked.` : `Card assigned to ${person.firstName}.`)}
          onRefresh={() => undefined}
        />
      ) : (
        <p role="status">Loading readers…</p>
      )}
    </Modal>
  );
}

function SuperviseDialog({ person, timeZone, onClose, onDone }: { person: Person; timeZone: string; onClose: () => void; onDone: (m: string) => void }) {
  const resources = useApi<AccessResource[]>("/admin/access/resources");
  const options = (resources.data ?? []).filter((r) => r.kind !== "building");
  return (
    <RecordDialog
      title="Start supervised use"
      submitLabel="Start"
      onClose={onClose}
      onDone={onDone}
      onSubmit={async (f) => {
        const [kind, resourceId] = String(f.get("resource")).split(":");
        const minutes = Number(f.get("duration"));
        await api("/admin/access/overrides", {
          method: "POST",
          body: { userId: person.id, kind, resourceId: Number(resourceId), durationMinutes: minutes, reason: f.get("reason") },
        });
        const name = options.find((r) => `${r.kind}:${r.id}` === f.get("resource"))?.name ?? "it";
        return `${person.firstName} can use ${name} for ${minutes} minutes while you watch.`;
      }}
    >
      <p className="mr-dialog__lead">Unlocks one machine or room while you watch. Membership, waiver and training rules still apply. Times use {timeZone.replace(/_/g, " ")}.</p>
      {resources.error ? <p role="alert" className="form-error">{resources.error}</p> : null}
      <label className="form-field">
        <span>Machine or room</span>
        <select name="resource" required defaultValue="">
          <option value="">{resources.loading ? "Loading…" : "Choose one"}</option>
          {options.map((r) => (
            <option key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`}>
              {r.name} · {r.kind === "room" ? "room" : "machine"}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        <span>How long</span>
        <select name="duration" defaultValue="15">
          {[5, 10, 15, 30].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
      <Reason />
    </RecordDialog>
  );
}

function SponsorDialog({
  person,
  supervision,
  onClose,
  onDone,
}: {
  person: Person;
  supervision: SupervisionSummary | null;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const sponsor = supervision?.sponsor ?? null;
  const [adult, setAdult] = useState(sponsor ? String(sponsor.id) : "");
  return (
    <RecordDialog
      title={sponsor ? "Change sponsoring adult" : "Link a sponsoring adult"}
      submitLabel="Save sponsoring adult"
      submitDisabled={!adult || adult === String(sponsor?.id)}
      onClose={onClose}
      onDone={onDone}
      onSubmit={async (f) => {
        await api(`/admin/users/${person.id}/supervision`, {
          method: "POST",
          body: { adultId: Number(adult), revision: sponsor?.revision ?? 0, consent: f.get("consent") === "on", reason: f.get("reason") },
        });
        return `Sponsoring adult saved for ${person.firstName}.`;
      }}
    >
      <p className="mr-dialog__lead">{person.firstName} is under 18. Their sponsoring adult checks in first and stays while they’re here.</p>
      <MemberSelect
        label="Adult account"
        name="adultId"
        value={adult}
        onChange={setAdult}
        selectedMember={sponsor ? { id: sponsor.id, name: sponsor.name, email: sponsor.email ?? "" } : undefined}
      />
      <label className="mr-check">
        <input type="checkbox" name="consent" required />
        <strong>I checked in person that this adult agrees</strong>
        <small>Each of them still needs their own membership or pass and signed policies.</small>
      </label>
      <Reason />
    </RecordDialog>
  );
}
