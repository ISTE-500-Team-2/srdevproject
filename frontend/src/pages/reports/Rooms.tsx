import type { Report } from "../../lib/reportContracts";
import { plural } from "./format";
import { Fill, Panel } from "./parts";

export function Rooms({ rooms }: { rooms: Report["rooms"] }) {
  const busiest = Math.max(1, ...rooms.map((r) => r.recordedCheckIns));
  return (
    <Panel id="reports-rooms" title="Room visits">
      {rooms.length ? (
        <ul className="reports-rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="reports-rooms__name">
                <b>{r.name}</b>
                {/* A room without a set capacity comes back null: leave it out rather than print nothing. */}
                {r.capacity == null ? null : <small>Holds {r.capacity}</small>}
              </span>
              <span className="reports-rooms__count">
                <b>{plural(r.recordedCheckIns, "visit", "visits")}</b>
                <small>{plural(r.distinctVisitors, "person", "different people")}</small>
              </span>
              <Fill value={(r.recordedCheckIns / busiest) * 100} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="reports-empty">No rooms are set up yet.</p>
      )}
    </Panel>
  );
}
