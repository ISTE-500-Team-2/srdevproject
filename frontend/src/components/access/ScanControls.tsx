import { useState } from "react";
import { Link } from "react-router-dom";
import type { ReaderSetup } from "../../lib/nfc";
import type { useCardScan } from "../../lib/useCardScan";

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
  const [reader, setReader] = useState("");
  const selected = available.find((r) => r.id === reader) ?? available[0];
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
          <label className="form-field">
            Reader for this scan
            <select
              value={selected?.id ?? ""}
              onChange={(e) => setReader(e.target.value)}
              disabled={scan.busy}
            >
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.online ? "Online" : "Offline"}
                </option>
              ))}
            </select>
          </label>
          {selected && !selected.online ? (
            <p className="nfc-help">
              This reader has not checked in recently. Connect it before tapping
              a card; refresh Readers to check its connection.
            </p>
          ) : null}
          <button
            type="button"
            className="button button--primary"
            disabled={scan.busy || !selected}
            onClick={() => selected && void scan.start(selected.id)}
          >
            {scan.busy ? "Starting scan…" : "Start card scan"}
          </button>
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
          {["waiting", "captured"].includes(scan.scan.status) ? (
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
            {["waiting", "captured"].includes(scan.scan.status)
              ? "Cancel scan"
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
