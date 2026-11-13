import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { dollars } from "../../../lib/display";
import type { Entitlement, Person } from "../../../lib/staffContracts";
import { daysUntil, plans as planSplit } from "./recordModel";
import { day, Row, type OpenDialog } from "./recordParts";

const ENTITLEMENT_WORDS: Record<string, string> = {
  active: "Active",
  scheduled: "Starts later",
  suspended: "Paused",
  revoked: "Ended early",
  expired: "Ended",
  cancelled: "Cancelled",
};
const entitlementTone = (s: string) => (s === "active" ? "ok" : s === "suspended" || s === "scheduled" ? "warn" : "neutral");

/** The member's current membership or day pass, then earlier ones (five until asked for all). */
export function RecordMembership({
  person: u,
  memberships,
  passes,
  canManage,
  allEarlier,
  showAllEarlier,
  open,
}: {
  person: Pick<Person, "id" | "status" | "firstName">;
  memberships: Entitlement[];
  passes: Entitlement[];
  canManage: boolean;
  allEarlier: boolean;
  showAllEarlier: () => void;
  open: OpenDialog;
}) {
  const { current, currentKind, earlier } = planSplit(memberships, passes);
  return (
    <section className="today-panel" id={`mr-plan-${u.id}`} aria-labelledby={`mr-plan-title-${u.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-plan-title-${u.id}`}>Membership</h2>
        {canManage ? (
          <button type="button" className="today-link" onClick={() => open({ kind: "sell" })}>
            Sell or record a payment <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {current && currentKind ? (
        <CurrentPlan item={current} kind={currentKind} held={u.status === "suspended"} first={u.firstName} canManage={canManage} open={open} />
      ) : (
        <p className="today-empty">No current membership or day pass.{canManage ? " Sell one or record a payment taken at the desk." : ""}</p>
      )}
      {earlier.length ? (
        <>
          <p className="mr-sub-head">Earlier</p>
          {(allEarlier ? earlier : earlier.slice(0, 5)).map(({ item, kind }) => (
            <Row
              key={`${kind}-${item.id}`}
              icon="receipt"
              title={
                <>
                  {item.plan?.name ?? (kind === "membership" ? "Membership" : "Day pass")} <small>#{item.id}</small>
                </>
              }
              detail={kind === "membership" ? `${day(item.startsAt!)} to ${day(item.endsAt!)}` : `Valid ${item.validDate ? day(item.validDate) : ""}`}
              end={
                <>
                  <span className={`status-pill status-pill--${entitlementTone(item.effectiveStatus)}`}>{ENTITLEMENT_WORDS[item.effectiveStatus] ?? item.effectiveStatus}</span>
                  {canManage && item.status !== "revoked" && item.effectiveStatus !== "expired" ? (
                    <button type="button" className="today-link" onClick={() => open({ kind: "entitlement", item, entitlementKind: kind })} aria-label={`Change ${item.plan?.name ?? kind} #${item.id}`}>
                      Change
                    </button>
                  ) : null}
                </>
              }
            />
          ))}
          {!allEarlier && earlier.length > 5 ? (
            <p className="mr-more">
              <button type="button" className="today-link" onClick={showAllEarlier}>
                Show all {earlier.length} <ChevronRight aria-hidden="true" />
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CurrentPlan({
  item,
  kind,
  held,
  first,
  canManage,
  open,
}: {
  item: Entitlement;
  kind: "membership" | "day_pass";
  held: boolean;
  first: string;
  canManage: boolean;
  open: OpenDialog;
}) {
  const name = item.plan?.name ?? (kind === "membership" ? "Membership" : "Day pass");
  const price = item.plan?.price ? dollars(item.plan.price) : "";
  const pay = item.cardBilled ? "card, renews automatically" : "paid at the desk";
  let bar: ReactNode;
  if (kind === "membership" && item.startsAt && item.endsAt) {
    const start = Date.parse(item.startsAt),
      end = Date.parse(item.endsAt),
      now = Date.now();
    const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
    const left = daysUntil(item.endsAt);
    const leftText = now < start ? `Starts ${day(item.startsAt)}` : left <= 0 ? "Ends today" : `${left} ${left === 1 ? "day" : "days"} left`;
    bar = (
      <>
        <div className="today-bar" role="img" aria-label={`${leftText}; ends ${day(item.endsAt)}`}>
          <span className="today-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="mr-plan__dates">
          <span>{day(item.startsAt)}</span>
          <strong>{leftText}</strong>
          <span>{day(item.endsAt)}</span>
        </div>
      </>
    );
  } else bar = <p className="mr-plan__dates"><strong>Valid {item.validDate ? day(item.validDate) : "today"}, until closing</strong></p>;
  return (
    <div className="mr-plan">
      <div className="mr-plan__top">
        <span className="mr-plan__name">
          {name}
          <span className={`status-pill status-pill--${entitlementTone(item.effectiveStatus)}`}>{ENTITLEMENT_WORDS[item.effectiveStatus] ?? item.effectiveStatus}</span>
        </span>
        <span className="mr-plan__price">{[price && (kind === "membership" ? `${price} a month` : price), kind === "membership" ? pay : ""].filter(Boolean).join(" · ")}</span>
      </div>
      {bar}
      {item.cancellationRequestedAt ? <p className="mr-plan__note">{first} asked to cancel; it ends on the date shown and won’t renew.</p> : null}
      {held && item.effectiveStatus === "active" ? <p className="mr-plan__note">Still running{item.cardBilled ? " and billing" : ""} while {first} is on hold.</p> : null}
      {canManage && item.status !== "revoked" ? (
        <div className="mr-plan__buttons">
          {kind === "membership" && item.endsAt && !item.cardBilled ? (
            <button type="button" className="today-button" onClick={() => open({ kind: "sell", renewal: item })}>
              Renew
            </button>
          ) : null}
          <button type="button" className="today-button" onClick={() => open({ kind: "entitlement", item, entitlementKind: kind })}>
            {kind === "membership" ? "Change membership access" : "Change status"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
