import { ChevronRight, Nfc } from "lucide-react";
import { timeOnly } from "../../../lib/display";
import type { NfcCard } from "../../../lib/nfc";
import type { Person } from "../../../lib/staffContracts";
import { day, Row, type OpenDialog } from "./recordParts";

/** The member's NFC card (the most recently used active one), then any others. */
export function RecordCards({
  person: u,
  cards,
  error,
  canManage,
  open,
}: {
  person: Pick<Person, "id" | "firstName" | "status" | "accessStatus">;
  /** Null until the cards load. */
  cards: NfcCard[] | null;
  error: string;
  canManage: boolean;
  open: OpenDialog;
}) {
  const first = u.firstName;
  const activeCards = (cards ?? []).filter((c) => c.active).sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const shownCard = activeCards[0] ?? null;
  const otherCards = (cards ?? []).filter((c) => c !== shownCard);
  const blockedCard = shownCard && (u.status !== "active" || u.accessStatus !== "active");
  return (
    <section className="today-panel" id={`mr-cards-${u.id}`} aria-labelledby={`mr-card-title-${u.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-card-title-${u.id}`}>{(cards ?? []).length > 1 ? "NFC cards" : "NFC card"}</h2>
        {canManage && shownCard ? (
          <button type="button" className="today-link" onClick={() => open({ kind: "assign" })}>
            Add another <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="form-error mr-pad">{error}</p> : null}
      {shownCard ? (
        <>
          <div className="mr-nfc" data-state={blockedCard ? "held" : "active"} role="img" aria-label={`${shownCard.label}${shownCard.last4 ? `, card ending ${shownCard.last4}` : ""}, ${blockedCard ? "refused while the account is blocked" : "active"}`}>
            <div className="mr-nfc__top">
              <span className="mr-nfc__brand">THE COLLABORATORY</span>
              <span className="mr-nfc__state">{blockedCard ? "Blocked" : "Active"}</span>
            </div>
            <Nfc className="mr-nfc__wave" aria-hidden="true" />
            <div>
              <div className="mr-nfc__label">{shownCard.label}</div>
              <div className="mr-nfc__num">•••• •••• {shownCard.last4 ?? "····"}</div>
            </div>
          </div>
          <p className="mr-nfc-meta">
            {blockedCard
              ? "Refused at every reader while the account or facility access is blocked."
              : shownCard.lastUsedAt
                ? `Last used ${day(shownCard.lastUsedAt)}, ${timeOnly(shownCard.lastUsedAt)}${shownCard.lastReader ? ` at ${shownCard.lastReader}` : ""}`
                : "Not used yet."}
          </p>
          {canManage ? (
            <div className="mr-nfc-actions">
              <button type="button" className="today-button" onClick={() => open({ kind: "assign", replacement: shownCard })}>
                Replace
              </button>
              <button type="button" className="today-button" onClick={() => open({ kind: "card", card: shownCard, action: "revoke" })}>
                Revoke
              </button>
            </div>
          ) : null}
        </>
      ) : cards ? (
        <>
          <div className="mr-nfc mr-nfc--none">
            <Nfc className="mr-nfc__wave" aria-hidden="true" />
            <strong>No card yet</strong>
            <span>Assign one so {first} can tap in at the readers.</span>
          </div>
          {canManage ? (
            <div className="mr-nfc-actions">
              <button type="button" className="today-button" onClick={() => open({ kind: "assign" })}>
                Assign a card
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="today-empty" role="status">Loading cards…</p>
      )}
      {otherCards.length ? (
        <div className="mr-other-cards">
          {otherCards.map((c) => (
            <Row
              key={c.id}
              icon="nfc"
              title={`${c.label}${c.last4 ? ` ••${c.last4}` : ""}`}
              detail={c.active ? (c.lastUsedAt ? `Last used ${day(c.lastUsedAt)}` : "Not used yet") : `Assigned ${day(c.assignedAt)}`}
              end={
                <>
                  <span className={`status-pill status-pill--${c.active ? "ok" : "neutral"}`}>{c.active ? "Active" : "Revoked"}</span>
                  {canManage ? (
                    <button type="button" className="today-link" onClick={() => open({ kind: "card", card: c, action: c.active ? "revoke" : "reactivate" })} aria-label={`${c.active ? "Revoke" : "Reactivate"} ${c.label}`}>
                      {c.active ? "Revoke" : "Reactivate"}
                    </button>
                  ) : null}
                </>
              }
            />
          ))}
        </div>
      ) : (
        <div className="mr-gap" />
      )}
    </section>
  );
}
