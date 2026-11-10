import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { facilityTime } from "../../lib/nfc";
import type { Tap } from "./TapHistory";

const SHOWN = 5;

/** Fits in a badge; the full sentence is on Tap history. */
const SHORT_DENIAL: Record<string, string> = {
  ACCOUNT_BLOCKED: "account blocked",
  ENTITLEMENT_REQUIRED: "no membership",
  WAIVER_REQUIRED: "waiver needed",
  WAIVERS_NOT_CONFIGURED: "waivers not set up",
  READER_DISABLED: "reader disabled",
  CARD_REVOKED: "card revoked",
  ENROLLMENT_CAPTURED: "captured for setup",
  ENROLLMENT_WAITING: "reader busy",
  CARD_NOT_ASSIGNED: "no card",
  ELIGIBILITY_EXPIRED: "check expired",
  RESERVATION_REQUIRED: "reservation needed",
  CERTIFICATION_REQUIRED: "training needed",
  RESOURCE_UNAVAILABLE: "unavailable",
  VERIFICATION_TIMEOUT: "timed out",
};

export function shortDenial(reason: string) {
  return SHORT_DENIAL[reason] ?? reason.toLowerCase().replaceAll("_", " ");
}

export function timeAgo(value: string, now = Date.now()) {
  const minutes = Math.floor((now - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

/**
 * The member-cards empty state: the latest taps, one click from the member's
 * cards (or, for a card nobody holds, from Find a card).
 */
export function RecentTaps({ timeZone }: { timeZone?: string }) {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const events = useApi<{ items: Tap[] }>(
    `/admin/access/events?result=${deniedOnly ? "denied" : "all"}`,
    { retainOnReload: true, refreshInterval: 30_000 },
  );
  const taps = events.data?.items.slice(0, SHOWN) ?? [];
  return (
    <section className="nfc-recent" aria-labelledby="nfc-recent-title">
      <div className="nfc-recent__heading">
        <h2 id="nfc-recent-title">Recent taps</h2>
        <div className="nfc-recent__tools">
          <div className="segmented" role="group" aria-label="Show taps">
            {[false, true].map((denied) => (
              <button
                key={String(denied)}
                type="button"
                aria-pressed={deniedOnly === denied}
                className={deniedOnly === denied ? "is-selected" : ""}
                onClick={() => setDeniedOnly(denied)}
              >
                {denied ? "Denied" : "All"}
              </button>
            ))}
          </div>
          <Link to="?view=history">Tap history →</Link>
        </div>
      </div>
      {events.loading ? (
        <p className="nfc-help" role="status">
          Loading recent taps…
        </p>
      ) : null}
      {events.error ? (
        <p className="nfc-help" role="alert">
          Recent taps could not load: {events.error}{" "}
          <button type="button" className="nfc-dismiss" onClick={events.reload}>
            Retry
          </button>
        </p>
      ) : null}
      {events.data && !taps.length ? (
        <p className="nfc-help">
          {deniedOnly ? "No denied taps yet." : "No taps yet."} Taps at any
          reader show up here.
        </p>
      ) : null}
      {taps.length ? (
        <ul className="nfc-recent__list">
          {taps.map((tap) => (
            <li key={tap.id}>
              <TapRow tap={tap} timeZone={timeZone} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TapRow({ tap, timeZone }: { tap: Tap; timeZone?: string }) {
  const member = tap.userId && tap.memberName ? tap.memberName : null;
  const name = member ?? (tap.last4 ? `Unknown card ••${tap.last4}` : "Unknown card");
  const body = (
    <>
      <span className={`nfc-recent__avatar${member ? "" : " is-unknown"}`} aria-hidden="true">
        {member ? initials(member) : "?"}
      </span>
      <span className="nfc-recent__who">
        <strong>{name}</strong>
        <span>
          {tap.readerName} ·{" "}
          <time
            dateTime={tap.createdAt}
            title={timeZone ? facilityTime(tap.createdAt, timeZone) : undefined}
          >
            {timeAgo(tap.createdAt)}
          </time>
        </span>
      </span>
      <span className={`activity-badge is-${tap.allowed ? "allowed" : "denied"}`}>
        {tap.allowed ? "Allowed" : `Denied · ${shortDenial(tap.reason)}`}
      </span>
    </>
  );
  // Members open their cards; a card nobody holds opens Find a card for that tap.
  const to = member
    ? `?member=${tap.userId}`
    : tap.last4
      ? `?view=lookup&tap=${tap.id}`
      : null;
  return to ? (
    <Link className="nfc-recent__row" to={to}>
      {body}
      <ChevronRight className="nfc-recent__chevron" aria-hidden="true" />
    </Link>
  ) : (
    <div className="nfc-recent__row">{body}</div>
  );
}
