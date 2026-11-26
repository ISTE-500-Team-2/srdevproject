import { TableScroll } from "../../components/TableScroll";
import type { Report } from "../../lib/reportContracts";
import { classTime } from "./format";
import { Fill, MoreLink, Panel, useLimit } from "./parts";

function classState(item: Report["classes"][number]) {
  if (item.status === "cancelled") return "Cancelled";
  return Date.parse(item.startsAt) < Date.now() ? "Held" : "Upcoming";
}
const stateTone = { Held: "ok", Upcoming: "neutral", Cancelled: "warn" } as const;

export function Classes({ classes, zone }: { classes: Report["classes"]; zone: string }) {
  const sorted = [...classes].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const { shown, toggle } = useLimit(sorted, 8, "classes");
  const held = sorted.filter((c) => classState(c) === "Held");
  const booked = held.reduce((n, c) => n + c.enrolled, 0);
  const came = held.reduce((n, c) => n + c.attended, 0);
  return (
    <Panel id="reports-classes" title="Classes" aside={<MoreLink to="/classes">Open Classes</MoreLink>}>
      <dl className="analytics-totals">
        <div><dt>Classes</dt><dd>{sorted.length}</dd></div>
        <div><dt>Held</dt><dd>{held.length}</dd></div>
        {booked ? <div><dt>Showed up</dt><dd>{came} of {booked} ({Math.round((came / booked) * 100)}%)</dd></div> : null}
      </dl>
      {sorted.length ? (
        <>
          <TableScroll label="Classes">
            <table className="data-table reports-table">
              <thead>
                <tr>
                  <th scope="col">Class</th>
                  <th scope="col">Starts</th>
                  <th scope="col">Status</th>
                  <th scope="col">Registered</th>
                  <th scope="col" className="table-number">Attended</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const state = classState(c);
                  return (
                    <tr key={c.id} className={state === "Cancelled" ? "is-idle" : undefined}>
                      <td>{c.title}</td>
                      <td className="reports-nowrap">{classTime(c.startsAt, zone)}</td>
                      <td>
                        <span className={`status-pill status-pill--${stateTone[state]}`}>{state}</span>
                      </td>
                      <td>
                        <span className="reports-rate">
                          <Fill value={Number(c.filledPercent)} />
                          <span>
                            <b>{c.enrolled} / {c.capacity}</b> <small>{Math.round(Number(c.filledPercent))}%</small>
                          </span>
                        </span>
                      </td>
                      <td className="table-number">{state === "Held" ? c.attended : <span className="reports-muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
          {toggle}
        </>
      ) : (
        <p className="reports-empty">No classes in this period.</p>
      )}
    </Panel>
  );
}
