// Focused member-record mutation dialogs carry revisions and reasons so stale edits can be rejected
// and changes attributed.

import { useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "../../../lib/api";
import { editingFormRef } from "../../../lib/editingForms";
import { dollars } from "../../../lib/display";
import type { AccessResource, NfcCard, ReaderSetup } from "../../../lib/nfc";
import type { SupervisionSummary } from "../../../lib/contracts";
import type { Entitlement, Payment, Person, Plan } from "../../../lib/staffContracts";
import { useApi } from "../../../lib/useApi";
import { AssignCard } from "../../access/MemberCards";
import { READER_POLL_MS } from "../../access/ScanControls";
import { MemberSelect } from "../../MemberSelect";
import { Modal } from "../../Modal";
import { AssistedPurchase } from "../AssistedPurchase";
import { CardRefund, PaymentEditor, paymentStatusName, refundAccepted, RefundReview } from "../PaymentControls";
import { AUTOMATIC_ROLES, ROLES, roleName } from "./recordModel";
import { day } from "./recordParts";
import { MemberPhoto } from "../../MemberPhoto";
import { initials } from "../../admin/people";

export type DialogState =
  | { kind: "status"; lift?: boolean }
  | { kind: "access"; restore?: boolean }
  | { kind: "roles" }
  | { kind: "conduct" }
  | { kind: "profile" }
  | { kind: "photo"; version: string }
  | { kind: "sell"; renewal?: Entitlement }
  | { kind: "entitlement"; item: Entitlement; entitlementKind: "membership" | "day_pass" }
  | { kind: "stopRenewal"; item: Entitlement }
  | { kind: "payment"; payment: Payment }
  | { kind: "refund"; payment: Payment }
  | { kind: "assign"; replacement?: NfcCard }
  | { kind: "card"; card: NfcCard; action: "revoke" | "reactivate" }
  | { kind: "supervise" }
  | { kind: "endSupervision"; override: { id: number; resourceName: string } }
  | { kind: "sponsor" };

/** A message written for staff, shown as is (errorMessage() keeps only server messages). */
class DialogMessage extends Error {}
/** The record changed under an open dialog: the dialog stops offering a retry on old data. */
class StaleDialog extends DialogMessage {}

/**
 * A record dialog's Modal. Once staff change anything in it, a stray click outside or Escape asks
 * before throwing the draft away. `dirty` adds work that no change event reports, such as a captured
 * card scan.
 */
function DraftModal({
  children,
  dirty = false,
  ...props
}: Omit<ComponentProps<typeof Modal>, "children"> & { children: ReactNode }) {
  const [edited, setEdited] = useState(false);
  return (
    <Modal {...props} dirty={dirty || edited}>
      <div className="mr-dialog__draft" onChangeCapture={() => setEdited(true)}>
        {children}
      </div>
    </Modal>
  );
}

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
      setError(err instanceof DialogMessage ? err.message : errorMessage(err));
      if (err instanceof StaleDialog) setStale(true);
      setBusy(false);
    }
  };
  return (
    <DraftModal open width={wide ? "regular" : "compact"} title={title} onClose={onClose} dismissible={!busy} className="mr-dialog">
      {/* editingFormRef: the record's background refresh waits while this is being edited. */}
      <form ref={editingFormRef} className="management-form mr-dialog__form" aria-label={title} onSubmit={submit}>
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
    </DraftModal>
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
  /** A change was saved: show this sentence and refresh the record. `problem`: it saved, but didn't work (a card refund Stripe didn't complete). */
  onDone: (message: string, problem?: boolean) => void;
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
        // The dialog re-reads the member's latest revision, so saving again is a deliberate second try.
        throw new DialogMessage("Someone else changed this account just now. The latest is loaded; check it and save again.");
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
          <p className="mr-dialog__lead">A staff restriction on the shop. While it’s on, {first} is signed out everywhere and can’t sign in.</p>
          <fieldset className="mr-options">
            <legend className="sr-only">Facility access</legend>
            <Choice name="status" value="active" title="No restriction" help="Membership, waiver and training rules decide access as usual." checked={dialog.restore || person.accessStatus === "active"} />
            <Choice name="status" value="suspended" title="Suspended" help="Sign-in, readers, check-in and new bookings refuse them, and any open visit ends." checked={!dialog.restore && person.accessStatus === "suspended"} tone="bad" />
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
    case "profile": {
      // Older accounts have no date of birth, so they can't sponsor a minor until staff add one.
      const addBirthDate = person.dobOnFile === false;
      return (
        <RecordDialog
          {...common}
          title={addBirthDate ? "Name, phone & date of birth" : "Name & phone"}
          submitLabel="Save"
          onSubmit={async (f) => {
            const dob = String(f.get("dob") ?? "");
            await write(`/admin/users/${id}/profile`, "PATCH", {
              firstName: f.get("firstName"),
              lastName: f.get("lastName"),
              phone: f.get("phone"),
              ...(dob ? { dob } : {}),
              reason: String(f.get("reason") ?? "").trim() || undefined,
            });
            return dob ? "Name, phone and date of birth saved." : "Name and phone saved.";
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
          {addBirthDate ? (
            <label className="form-field">
              <span>
                Date of birth<span className="mr-optional"> (optional)</span>
              </span>
              <input name="dob" type="date" max={new Date().toISOString().slice(0, 10)} autoComplete="off" aria-describedby="mr-dob-hint" />
            </label>
          ) : null}
          {addBirthDate ? (
            <p id="mr-dob-hint" className="mr-dialog__hint">
              None is on file, so {first} can’t sponsor a minor yet. Check it before saving: it can’t be changed here afterwards.
            </p>
          ) : null}
          <p className="mr-dialog__hint">Email is how {first} signs in, so they change it from their own profile.</p>
          <Reason optional />
        </RecordDialog>
      );
    }
    case "photo":
      return (
        <RecordDialog
          {...common}
          title="Remove profile photo"
          submitLabel="Remove photo"
          danger
          onSubmit={async (f) => {
            try {
              await api(`/admin/users/${id}/photo`, {
                method: "DELETE",
                body: { version: dialog.version, reason: String(f.get("reason") ?? "").trim() },
              });
            } catch (error) {
              if (error instanceof ApiError && error.status === 409 && error.code === "STALE_RECORD") {
                onConflict();
                throw new StaleDialog(`${first} changed their photo just now. Close this and look at the new one.`);
              }
              throw error;
            }
            return "Photo removed.";
          }}
        >
          <MemberPhoto id={id} version={dialog.version} className="mr-photo-preview">
            {initials(person.firstName, person.lastName)}
          </MemberPhoto>
          <p className="mr-dialog__lead">
            {first} added this photo. Remove it if it isn’t a clear photo of them. We’ll email {first} that it was removed and that
            they can add a new one; your reason stays in the change log.
          </p>
          <Reason />
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
              // Other refusals (such as card renewal still on) keep the server's own explanation.
              if (error instanceof ApiError && error.status === 409 && error.code === "STALE_RECORD") {
                onConflict();
                throw new StaleDialog(`This ${noun} changed since you opened it. The latest is loaded; close this and check it before trying again.`);
              }
              throw error;
            }
            const message = status === "active" ? `The ${noun} access is active.` : status === "suspended" ? `The ${noun} access is suspended.` : `The ${noun} access has ended.`;
            return item.cardBilled ? `${message} Card billing is unchanged.` : message;
          }}
        >
          <p className="mr-dialog__lead">
            This changes access only; it does not extend the end date or issue a refund.
            {item.cardBilled ? " It does not pause or cancel card billing." : ""}
            {item.autoRenews ? " To end access, first choose Stop auto-renew on this membership." : ""}
          </p>
          <fieldset className="mr-options">
            <legend className="sr-only">{noun} status</legend>
            <Choice name="status" value="active" title="Active" help="Grants access until its end date." checked={item.status === "active"} />
            <Choice name="status" value="suspended" title="Suspend access" help="Doesn’t grant access until you make it active again, within its original dates." checked={item.status === "suspended"} />
            <Choice name="status" value="revoked" title="End access now" help={`Can’t be undone. Issue a new ${noun} to give access again.`} checked={false} tone="bad" />
          </fieldset>
          <Reason />
        </RecordDialog>
      );
    }
    case "stopRenewal": {
      const item = dialog.item;
      return (
        <RecordDialog
          {...common}
          title={`Stop auto-renew for ${item.plan?.name ?? "this membership"}?`}
          submitLabel="Stop auto-renew"
          danger
          onSubmit={async (f) => {
            const { endsAt, emailed } = await api<{ endsAt: string | null; emailed: boolean }>(
              `/admin/users/${id}/memberships/${item.id}/stop-renewal`,
              { method: "POST", body: { reason: f.get("reason") } },
            );
            const last = endsAt ? `; card billing ends ${day(endsAt)}` : "";
            // No email reaches an account on hold or one that turned membership emails off.
            return emailed
              ? `${first}’s auto-renew is off${last}. ${first} gets an email with the last day.`
              : `${first}’s auto-renew is off${last}. ${first} won’t get an email about it, so let them know the last day.`;
          }}
        >
          {item.renewalStopPending && item.renewalEndsAt ? (
            <p className="mr-dialog__lead">
              The last day, {day(item.renewalEndsAt)}, is already set, but the payment provider hasn’t confirmed it. This asks
              it again; the day doesn’t move.
            </p>
          ) : (
            <p className="mr-dialog__lead">
              For when {first} can’t do it from their own account, even while it’s on hold or restricted. It works as if {first}
              had: billing ends on the first billing date at least 30 days from today, so there may be one more charge, and the
              membership runs until then. This doesn’t change access: end or suspend it separately.
            </p>
          )}
          <Reason />
        </RecordDialog>
      );
    }
    case "sell":
      return (
        <DraftModal open width="regular" title={dialog.renewal ? `Renew ${dialog.renewal.plan?.name ?? "membership"}` : "Sell or record a payment"} onClose={onClose} className="mr-dialog">
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
        </DraftModal>
      );
    case "payment":
      return (
        <DraftModal open width="compact" title={`Payment #${dialog.payment.id}`} onClose={onClose} className="mr-dialog">
          <PaymentEditor payment={dialog.payment} onSaved={(status) => onDone(`Payment #${dialog.payment.id} marked ${paymentStatusName(status).toLowerCase()}.`)} />
        </DraftModal>
      );
    case "refund":
      if (dialog.payment.refundStatus === "needs_review") {
        return (
          <DraftModal open width="compact" title="Review refund" onClose={onClose} className="mr-dialog">
            <RefundReview payment={dialog.payment} onReviewed={onDone} />
          </DraftModal>
        );
      }
      return (
        <DraftModal open width="compact" title={`Refund ${dollars(dialog.payment.amount)}`} onClose={onClose} className="mr-dialog">
          <CardRefund payment={dialog.payment} onRefunded={(status) =>
              onDone(
                status === "succeeded"
                  ? `Refunded ${dollars(dialog.payment.amount)}.`
                  : refundAccepted(status)
                    ? `Refund of ${dollars(dialog.payment.amount)} is on its way.`
                    : `Stripe didn't complete the refund of ${dollars(dialog.payment.amount)}. Check it in Stripe.`,
                !refundAccepted(status),
              )
            } />
        </DraftModal>
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
      <div className="mr-roles mr-roles--automatic" role="group" aria-label="Automatic roles">
        <div className="mr-roles__row mr-roles__row--head" aria-hidden="true">
          <span>Automatic</span>
          <span>Now</span>
        </div>
        {AUTOMATIC_ROLES.map((role) => (
          <div className="mr-roles__row" key={role}>
            <span>{roleName(role)}</span>
            <span>{person.automaticRoles?.includes(role) ? "Yes" : "No"}</span>
          </div>
        ))}
      </div>
      <p className="mr-roles__note">
        These follow purchases and can’t be set here. Subscriber applies while a membership is active or about to start;
        Day-pass customer while a day pass for today or later is booked.
      </p>
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
  // Re-read while open so readers going on or offline show up; a failed re-read keeps the
  // list (and any scan in progress) on screen rather than swapping it for the error.
  const setup = useApi<ReaderSetup>("/admin/access/readers", {
    retainOnReload: true,
    refreshInterval: READER_POLL_MS,
  });
  const name = `${person.firstName} ${person.lastName}`;
  // A tapped card arrives by polling, not a change event; closing would release the scan.
  const [captured, setCaptured] = useState(false);
  return (
    <DraftModal open width="regular" title={replacement ? `Replace ${replacement.label}` : "Assign an NFC card"} onClose={onClose} dirty={captured} className="mr-dialog mr-dialog--scan">
      {replacement ? <p className="mr-dialog__lead">{replacement.label} keeps working until the new card is saved.</p> : null}
      {setup.error && !setup.data ? (
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
          onCaptured={setCaptured}
        />
      ) : (
        <p role="status">Loading readers…</p>
      )}
    </DraftModal>
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
