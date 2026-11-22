import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { TableScroll } from "../../components/TableScroll";
import type { Report } from "../../lib/reportContracts";
import { hourName, hours, WEEKDAYS } from "./format";

/** Weekday by hour, one hue darkening with booked hours; hovering a square names it. */
export function BusiestTimes({ patterns: all }: { patterns: Report["patterns"] }) {
  const [machine, setMachine] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const machineList = [...new Map(all.map((p) => [p.id, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  // A machine that drops out of the data (its booking cancelled, a new range) ends its filter,
  // rather than leaving "No bookings" behind a select that can't show or clear it.
  const filtered = machineList.some(([id]) => String(id) === machine);
  if (machine && !filtered) setMachine("");
  const patterns = all.filter((p) => !filtered || String(p.id) === machine);
  const cells = new Map<string, number>();
  for (const p of patterns) cells.set(`${p.weekday}-${p.hour}`, (cells.get(`${p.weekday}-${p.hour}`) ?? 0) + Number(p.bookedHours));
  const busiest = Math.max(0, ...cells.values());
  const peak = [...cells.entries()].find(([, value]) => value === busiest)?.[0];
  const used = patterns.map((p) => p.hour);
  const first = Math.min(8, ...used);
  const last = Math.max(20, ...used);
  const hourList = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const describe = (key: string) => {
    const [weekday, hour] = key.split("-").map(Number);
    return `${WEEKDAYS[weekday - 1]} ${hourName(hour)}`;
  };
  const shown = hovered ?? peak;

  return (
    <>
      <div className="reports-heat-head">
        <h3>Busiest times</h3>
        {machineList.length > 1 || filtered ? (
          <label className="analytics-range reports-heat-filter">
            <select value={machine} aria-label="Machine" onChange={(e) => setMachine(e.target.value)}>
              <option value="">All machines</option>
              {machineList.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown className="analytics-range__chevron" aria-hidden="true" />
          </label>
        ) : null}
        {busiest ? (
          <span className="reports-heat-key" aria-hidden="true">
            Less <i /> <i /> <i /> <i /> More
          </span>
        ) : null}
      </div>
      {busiest ? (
        <>
          <div className="reports-heat-scroll">
            <table className="reports-heat" onMouseLeave={() => setHovered(null)}>
              <caption className="sr-only">Booked hours by weekday and starting hour</caption>
              <thead>
                <tr>
                  <td />
                  {hourList.map((h) => (
                    <th key={h} scope="col">
                      <span aria-hidden="true">{h % 3 === 0 ? hourName(h) : ""}</span>
                      <span className="sr-only">{hourName(h)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKDAYS.map((name, i) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    {hourList.map((h) => {
                      const key = `${i + 1}-${h}`;
                      const value = cells.get(key) ?? 0;
                      return (
                        <td key={h} className={hovered === key ? "is-hovered" : undefined} onMouseEnter={() => setHovered(key)}>
                          <i style={value ? { opacity: 0.18 + 0.82 * (value / busiest) } : undefined} className={value ? "is-on" : undefined} />
                          <span className="sr-only">{hours(value)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="period-readout reports-heat-readout" aria-hidden="true">
            {shown ? (
              <>
                <span className="period-readout__name">{describe(shown)}</span>
                <span>{hours(cells.get(shown) ?? 0)} booked hours</span>
                {!hovered ? <span className="period-readout__hint">The busiest hour. Hover a square to see another.</span> : null}
              </>
            ) : null}
          </p>
          <details className="analytics-table">
            <summary>Show as table</summary>
            <TableScroll label="Booked hours by weekday and hour">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Machine</th>
                    <th scope="col">Weekday</th>
                    <th scope="col" className="table-number">Hour</th>
                    <th scope="col" className="table-number">Booked hours</th>
                  </tr>
                </thead>
                <tbody>
                  {patterns.map((r, i) => (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td>{WEEKDAYS[r.weekday - 1]}</td>
                      <td className="table-number">{hourName(r.hour)}</td>
                      <td className="table-number">{hours(Number(r.bookedHours))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </details>
        </>
      ) : (
        <p className="reports-empty">No bookings in this period.</p>
      )}
    </>
  );
}
