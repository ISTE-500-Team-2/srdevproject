// Shared reader/manual-input controls for card lookup and assignment; useCardScan owns the
// enrollment lifecycle.

import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlert, Info } from "lucide-react";
import type { AccessReader, ReaderSetup } from "../../lib/nfc";
import type { useCardScan } from "../../lib/useCardScan";

/** How often a screen with the reader picker re-reads readers, so one plugged in shows up as online. */
export const READER_POLL_MS = 5000;

export function ScanControls({
  setup,
  scan,
  memberName,
}: {
  setup: ReaderSetup;
  scan: ReturnType<typeof useCardScan>;
  memberName?: string;
}) {
  const available = setup.readers.filter((r) => r.enabled);
  // Online readers first; an offline one can't capture a tap, so it can't be picked.
  const readers = [...available].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      // Online readers keep name order; offline ones list the most recently seen first.
      (a.online ? 0 : (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")),
  );
  const [reader, setReader] = useState("");
  const group = useId();
  const firstOnline = readers.find((r) => r.online);
  // A reader that goes offline stays chosen (and says so) rather than the scan silently
  // moving to another door or machine; only a missing choice falls back to an online one.
  const selected = readers.find((r) => r.id === reader) ?? firstOnline;
  const chosen = selected?.id ?? "";
  useEffect(() => {
    if (chosen && chosen !== reader) setReader(chosen);
  }, [chosen, reader]);
  if (!setup.configured)
    return (
      <p className="form-error" role="alert">
        NFC setup is incomplete. Ask the system administrator to configure the
        card security key.
      </p>
    );
  if (!available.length)
    return (
      <p className="empty-state">
        No enabled readers.{" "}
        <Link to="/admin/access?view=readers">Add or enable a reader</Link>{" "}
        before assigning or scanning cards.
      </p>
    );
  return (
    <div className="nfc-scan">
      {!scan.scan ? (
        <>
          <fieldset className="nfc-readers" disabled={scan.busy}>
            <legend>Reader</legend>
            {readers.map((r) => (
              <label
                key={r.id}
                className="nfc-reader"
                data-offline={r.online ? undefined : ""}
              >
                <input
                  type="radio"
                  name={group}
                  value={r.id}
                  checked={selected?.id === r.id}
                  disabled={!r.online}
                  onChange={() => setReader(r.id)}
                />
                <span className="nfc-reader__text">
                  <strong>{r.name}</strong>
                  <small>
                    {KIND[r.kind]} · {r.resourceName}
                  </small>
                </span>
                <span className="nfc-reader__status">
                  <i aria-hidden="true" />
                  {r.online ? "Online" : lastSeen(r.lastSeenAt)}
                </span>
              </label>
            ))}
          </fieldset>
          {selected?.online ? (
            <p className="nfc-scan__note">
              <Info aria-hidden="true" />
              <span>
                While scanning,{" "}
                {selected.kind === "equipment"
                  ? `${selected.resourceName} won’t turn on`
                  : `the ${selected.resourceName} door won’t open`}{" "}
                for anyone (up to 2 minutes).
              </span>
            </p>
          ) : (
            <p className="nfc-scan__offline" role="status">
              <CircleAlert aria-hidden="true" />
              <span>
                {selected
                  ? `${selected.name} just went offline. ${firstOnline ? "Pick another reader" : "Plug it back in"}, or enter the card ID by hand.`
                  : "No reader is online right now. Plug one in, or enter the card ID by hand."}
              </span>
            </p>
          )}
          {selected?.online ? (
            <button
              type="button"
              className="button button--primary"
              disabled={scan.busy}
              onClick={() => void scan.start(selected.id)}
            >
              {scan.busy ? "Starting scan…" : "Start card scan"}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="nfc-scan__state" role="status">
            {scan.scan.status === "waiting"
              ? `Tap one NFC card at ${setup.readers.find((r) => r.id === scan.scan?.readerId)?.name ?? scan.scan.readerId}${memberName ? ` for ${memberName}` : ""}.`
              : scan.scan.status === "captured"
                ? `Card captured · ending ${scan.scan.last4}`
                : scan.scan.status === "expired"
                  ? "This scan expired. Start a new scan."
                  : "This scan has ended."}
          </p>
          {scan.counting ? (
            <p className="nfc-help">
              {scan.seconds} seconds remaining. This scan does not open a door
              or activate equipment.
            </p>
          ) : null}
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void scan.cancel()}
          >
            {scan.counting
              ? "Cancel scan"
              : scan.scan.status === "captured"
                ? "Scan another card"
                : "Start over"}
          </button>
        </>
      )}
      {scan.error ? (
        <p className="form-error" role="alert">
          {scan.error}{" "}
          {scan.scan?.status === "waiting" ? (
            <button type="button" onClick={scan.retry}>
              Retry scan status
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

const KIND: Record<AccessReader["kind"], string> = {
  building: "Building door",
  room: "Room door",
  equipment: "Machine",
  studio: "Studio door",
};
const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function lastSeen(at: string | null) {
  if (!at) return "Never connected";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(at)) / 60000),
  );
  if (minutes < 1) return "Offline · just now";
  if (minutes < 60) return `Offline · ${ago.format(-minutes, "minute")}`;
  if (minutes < 48 * 60)
    return `Offline · ${ago.format(-Math.round(minutes / 60), "hour")}`;
  return `Offline · ${ago.format(-Math.round(minutes / 1440), "day")}`;
}
