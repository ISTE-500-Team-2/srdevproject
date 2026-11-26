import { Nfc } from "lucide-react";
import { statusLabel } from "../../lib/display";
import type { Report } from "../../lib/reportContracts";
import { plural } from "./format";
import { MoreLink, Panel } from "./parts";

/** Who holds a reader right now. Ignores the date range. */
export function LiveReaders({ report: d }: { report: Report }) {
  const live = d.live.filter((r) => r.activeReaderLeases > 0);
  // Building, room and machine numbers overlap, so only look a number up in its own list.
  const name = (r: Report["live"][number]) => {
    if (r.kind === "building" || r.resourceId === null) return "Front door";
    const list = r.kind === "room" ? d.rooms : r.kind === "equipment" ? d.equipment : [];
    return list.find((item) => item.id === r.resourceId)?.name ?? `${statusLabel(r.kind)} ${r.resourceId}`;
  };
  const place = (r: Report["live"][number]) => {
    if (r.kind === "building") return "Building";
    if (r.resourceId === null) return null;
    return r.kind === "room" ? "Room" : r.kind === "equipment" ? "Machine" : statusLabel(r.kind);
  };
  // Busiest reader first.
  live.sort((a, b) => b.activeReaderLeases - a.activeReaderLeases);
  return (
    <Panel
      id="reports-live"
      title={
        <>
          <span className={`reports-pulse${live.length ? " is-on" : ""}`} aria-hidden="true" />
          Signed in at readers
        </>
      }
      info="Everyone who has tapped in. They stay on this list until their booking ends or we close, even if they've left."
      aside={<MoreLink to="/admin/access">Reader access</MoreLink>}
    >
      {live.length ? (
        <ul className="reports-live">
          {live.map((r) => (
            <li key={`${r.kind}-${r.resourceId}`}>
              <Nfc aria-hidden="true" />
              <span className="reports-live__name">
                {name(r)}
                {place(r) ? <small>{place(r)}</small> : null}
              </span>
              <b>{plural(r.activeReaderLeases, "person", "people")}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="reports-note reports-note--flush">Nobody is signed in at a reader right now.</p>
      )}
    </Panel>
  );
}
