import { useState } from "react";
import { Link } from "react-router-dom";
import { TableScroll } from "../../components/TableScroll";
import type { Report } from "../../lib/reportContracts";
import { BusiestTimes } from "./BusiestTimes";
import { count, hours, percent, plural } from "./format";
import { Fill, MoreLink, Panel } from "./parts";

export function Equipment({ report: d }: { report: Report }) {
  const [showIdle, setShowIdle] = useState(false);
  const authorized = (id: number) => Number(d.usage.find((u) => u.equipmentId === id)?.authorizedHours ?? 0);
  // Busiest first; machines nobody booked or used wait behind a toggle.
  const machines = [...d.equipment].sort((a, b) => b.bookedHours - a.bookedHours || a.name.localeCompare(b.name));
  const used = machines.filter((e) => e.reservations || authorized(e.id));
  const idle = machines.filter((e) => !e.reservations && !authorized(e.id));
  const rows = showIdle ? machines : used;
  const bookings = machines.reduce((n, e) => n + e.reservations, 0);
  const booked = machines.reduce((n, e) => n + e.bookedHours, 0);

  return (
    <Panel
      id="reports-equipment"
      title="Equipment"
      info="Share of the period booked compares a machine's booked hours with every hour in the dates you picked, including hours when we're closed."
      aside={<MoreLink to="/admin/equipment">Open Equipment</MoreLink>}
    >
      <dl className="analytics-totals">
        <div><dt>Bookings</dt><dd>{count(bookings)}</dd></div>
        <div><dt>Booked hours</dt><dd>{hours(booked)}</dd></div>
        <div><dt>Hours tapped in</dt><dd>{hours(machines.reduce((n, e) => n + authorized(e.id), 0))}</dd></div>
        <div><dt>Machines used</dt><dd>{used.length} of {machines.length}</dd></div>
      </dl>
      {rows.length ? (
        <TableScroll label="Equipment use">
          <table className="data-table reports-table">
            <thead>
              <tr>
                <th scope="col">Machine</th>
                <th scope="col" className="table-number">Bookings</th>
                <th scope="col" className="table-number">Booked hours</th>
                <th scope="col">Share of the period booked</th>
                <th scope="col" className="table-number">Hours tapped in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.reservations || authorized(e.id) ? undefined : "is-idle"}>
                  <td>
                    <Link className="reports-name" to={`/admin/equipment/${e.id}`}>{e.name}</Link>
                  </td>
                  <td className="table-number">{e.reservations}</td>
                  <td className="table-number">{hours(e.bookedHours)}</td>
                  <td>
                    <span className="reports-rate">
                      <Fill value={e.bookedUtilizationPercent} />
                      <b>{percent(e.bookedUtilizationPercent)}</b>
                    </span>
                  </td>
                  <td className="table-number">{hours(authorized(e.id))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p className="reports-empty">
          {machines.length ? "No machines were booked or used." : "No machines are set up yet."}
        </p>
      )}
      {idle.length && used.length ? (
        <button type="button" className="analytics-more" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}>
          {showIdle ? "Hide unused machines" : `Show ${plural(idle.length, "unused machine", "unused machines")}`}
        </button>
      ) : idle.length && !showIdle ? (
        <button type="button" className="analytics-more" aria-expanded={false} onClick={() => setShowIdle(true)}>
          List every machine
        </button>
      ) : null}
      <BusiestTimes patterns={d.patterns} />
    </Panel>
  );
}
