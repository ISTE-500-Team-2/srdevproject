import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../lib/api";
import { dateTime } from "../../lib/display";
import { useApi } from "../../lib/useApi";
import { useCardScan } from "../../lib/useCardScan";
import { uidHelp, type NfcCard, type ReaderSetup } from "../../lib/nfc";
import { LoadState } from "../Management";
import { Modal } from "../Modal";
import { ScanControls } from "./ScanControls";

export function MemberCards({
  userId,
  memberName,
  onChanged,
}: {
  userId: number;
  memberName: string;
  onChanged?: () => void;
}) {
  const cards = useApi<NfcCard[]>(`/admin/access/cards?userId=${userId}`);
  const setup = useApi<ReaderSetup>("/admin/access/readers");
  const [action, setAction] = useState<{
    card: NfcCard;
    kind: "revoke" | "reactivate";
  } | null>(null);
  const [replacement, setReplacement] = useState<NfcCard | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const changed = (message: string) => {
    setError("");
    setNotice(message);
    cards.reload();
    onChanged?.();
  };
  async function changeCard(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!action) return;
    const reason = new FormData(e.currentTarget).get("reason");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/access/cards/${action.card.id}/${action.kind}`, {
        method: "POST",
        body: { expectedRevision: action.card.revision, reason },
      });
      changed(
        `${action.card.label} ${action.kind === "revoke" ? "revoked" : "reactivated"} for ${memberName}.`,
      );
      setAction(null);
    } catch (e) {
      setError(errorMessage(e));
      cards.reload();
      setAction(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nfc-section" aria-label={`NFC cards for ${memberName}`}>
      <div className="nfc-section__heading">
        <h2>NFC cards for {memberName}</h2>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            setError("");
            setNotice("");
            cards.reload();
            setup.reload();
          }}
          disabled={cards.loading}
        >
          {" "}
          {cards.loading ? "Loading cards…" : "Refresh cards"}
        </button>
      </div>
      <LoadState {...cards} />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="form-notice" role="status">
          {notice}{" "}
          <button
            type="button"
            className="nfc-dismiss"
            onClick={() => setNotice("")}
            aria-label="Dismiss card confirmation"
          >
            Dismiss
          </button>
        </p>
      ) : null}
      {cards.data?.length === 0 ? (
        <p className="empty-state">
          No NFC cards are assigned to {memberName}. Choose a reader below to
          assign their first card.
        </p>
      ) : null}
      <div className="nfc-card-list">
        {cards.data?.map((card) => (
          <article className="nfc-card" key={card.id}>
            <div className="nfc-section__heading">
              <h3>{card.label}</h3>
              <span
                className={`activity-badge is-${card.active ? "allowed" : "neutral"}`}
              >
                {card.active ? "Active" : "Revoked"}
              </span>
            </div>
            <p className="nfc-card__suffix">
              {card.last4
                ? `Card ending ${card.last4}`
                : "Card ID unavailable for this older assignment"}
            </p>
            <p className="nfc-help">
              Assigned {dateTime(card.assignedAt)}
              {card.assignedBy ? ` by ${card.assignedBy}` : ""}
            </p>
            <p className="nfc-help">
              {card.lastUsedAt
                ? `Last used ${dateTime(card.lastUsedAt)} at ${card.lastReader}`
                : "No recorded successful taps."}
            </p>
            <div className="management-actions">
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  setError("");
                  setNotice("");
                  setAction({
                    card,
                    kind: card.active ? "revoke" : "reactivate",
                  });
                }}
              >
                {card.active ? "Revoke" : "Reactivate"} {card.label}
              </button>
              {card.active ? (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => {
                    setReplacement(card);
                    setError("");
                    setNotice("");
                  }}
                >
                  Replace {card.label}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <LoadState {...setup} />
      {setup.error ? (
        <button
          type="button"
          className="button button--quiet"
          onClick={setup.reload}
        >
          Retry reader setup
        </button>
      ) : null}
      {setup.data ? (
        <AssignCard
          key={`${userId}:${replacement?.id ?? "new"}`}
          userId={userId}
          memberName={memberName}
          setup={setup.data}
          replacement={replacement}
          onCancelReplacement={() => setReplacement(null)}
          onSaved={() => {
            changed(
              replacement
                ? `Replacement NFC card assigned to ${memberName}; ${replacement.label} revoked.`
                : `NFC card assigned to ${memberName}.`,
            );
            setReplacement(null);
          }}
          onRefresh={cards.reload}
        />
      ) : null}
      <Modal
        open={!!action}
        title={`${action?.kind === "revoke" ? "Revoke" : "Reactivate"} ${action?.card.label ?? "NFC card"}?`}
        onClose={() => {
          if (!busy) setAction(null);
        }}
        width="compact"
      >
        {action ? (
          <form className="management-form" onSubmit={changeCard}>
            <p>
              {action.kind === "revoke"
                ? `This card will stop granting access for ${memberName}.`
                : `This card will be active for ${memberName} again. Normal access requirements still apply.`}
            </p>
            <label>
              Reason
              <input name="reason" required maxLength={500} disabled={busy} />
            </label>
            <div className="management-actions">
              <button className="button button--primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : action.kind === "revoke"
                    ? "Confirm revocation"
                    : "Confirm reactivation"}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </section>
  );
}

function AssignCard({
  userId,
  memberName,
  setup,
  replacement,
  onCancelReplacement,
  onSaved,
  onRefresh,
}: {
  userId: number;
  memberName: string;
  setup: ReaderSetup;
  replacement: NfcCard | null;
  onCancelReplacement: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const scan = useCardScan("assign", userId);
  const uidId = useId();
  const [manual, setManual] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [formKey, setFormKey] = useState(0);
  const enabled = setup.configured && setup.readers.some((r) => r.enabled);
  const owner = scan.scan?.assignments?.find((a) => a.active);
  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const uid = String(f.get("uid") ?? "");
    if (
      manual &&
      !/^(?:[A-F0-9]{8}|[A-F0-9]{14}|[A-F0-9]{20})$/i.test(
        uid.replace(/[: -]/g, ""),
      )
    ) {
      setError("Enter 8, 14 or 20 hexadecimal characters for the NFC card ID.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/admin/access/cards", {
        method: "POST",
        body: {
          userId,
          label: f.get("label"),
          reason: f.get("reason"),
          ...(manual ? { uid } : { enrollmentId: scan.scan?.id }),
          ...(replacement
            ? {
                replaceCardId: replacement.id,
                expectedRevision: replacement.revision,
              }
            : {}),
        },
      });
      await scan.cancel();
      setFormKey((n) => n + 1);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      onRefresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="nfc-assignment"
      aria-label={replacement ? "Replace NFC card" : "Assign NFC card"}
    >
      <h3>
        {replacement ? `Replace ${replacement.label}` : "Assign an NFC card"}
      </h3>
      {replacement ? (
        <p>
          The old card stays active until the replacement is successfully
          assigned.{" "}
          <button
            type="button"
            className="nfc-dismiss"
            onClick={onCancelReplacement}
            disabled={busy}
          >
            Cancel replacement
          </button>
        </p>
      ) : null}
      {!manual ? (
        <>
          <ol className="nfc-steps">
            <li>Choose a reader</li>
            <li>Tap one card</li>
            <li>Confirm for {memberName}</li>
          </ol>
          <ScanControls setup={setup} scan={scan} memberName={memberName} />
        </>
      ) : null}
      {enabled && !scan.scan ? (
        <button
          type="button"
          className="button button--quiet"
          disabled={busy || scan.busy}
          onClick={() => {
            setManual((v) => !v);
            setError("");
            setFormKey((n) => n + 1);
          }}
        >
          {manual ? "Use a reader instead" : "Enter a card ID manually"}
        </button>
      ) : null}
      {enabled && (manual || scan.scan?.status === "captured") ? (
        <form
          key={formKey}
          className="management-form"
          aria-label={`Confirm NFC card for ${memberName}`}
          onSubmit={assign}
        >
          <p>
            <strong>
              Assign{" "}
              {manual ? "this NFC card" : `card ending ${scan.scan?.last4}`} to{" "}
              {memberName}.
            </strong>{" "}
            Confirm the member and card before saving.
          </p>
          {owner ? (
            <p className="form-error" role="alert">
              This card is already assigned to {owner.memberName} ({owner.label}
              ). Revoke that assignment before reissuing it.
            </p>
          ) : null}
          <fieldset disabled={busy}>
            {manual ? (
              <div>
                <label htmlFor={uidId}>NFC card ID</label>
                <input
                  id={uidId}
                  name="uid"
                  required
                  autoComplete="off"
                  aria-describedby={`${uidId}-help`}
                  maxLength={40}
                />
                <small id={`${uidId}-help`} className="nfc-help">
                  {uidHelp}
                </small>
              </div>
            ) : null}
            <label>
              Card label
              <input
                name="label"
                required
                maxLength={100}
                placeholder="For example, blue key card"
              />
            </label>
            <label>
              Assignment reason
              <input name="reason" required maxLength={500} />
            </label>
            <button className="button button--primary" disabled={!!owner}>
              {busy
                ? "Assigning card…"
                : replacement
                  ? "Confirm replacement"
                  : "Assign card"}
            </button>
          </fieldset>
        </form>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
