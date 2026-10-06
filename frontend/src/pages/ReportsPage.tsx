import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import {
  LoadState,
  dollars,
  dateTime,
  zonedDay,
} from "../components/Management";
type Report = {
  from: string;
  to: string;
  timeZone: string;
  generatedAt: string;
  notes: string[];
  revenue: {
    period: string;
    category: string;
    method: string;
    receipts: number;
    gross: string;
    refunds: string;
    net: string;
  }[];
  equipment: {
    id: number;
    name: string;
    bookedHours: number;
    bookedUtilizationPercent: number;
    reservations: number;
  }[];
  patterns: {
    id: number;
    name: string;
    weekday: number;
    hour: number;
    bookedHours: string;
  }[];
  classes: {
    id: number;
    title: string;
    capacity: number;
    enrolled: number;
    attended: number;
    filledPercent: string;
    status: string;
    startsAt: string;
  }[];
  rooms: {
    id: number;
    name: string;
    capacity: number;
    recordedCheckIns: number;
    distinctVisitors: number;
  }[];
  active: { activeUsers: number; approvedCheckIns: number };
  compliance: {
    activeAccounts: number;
    restrictedAccounts: number;
    expiredTraining: number;
  };
  live: {
    kind: string;
    resourceId: number | null;
    activeReaderLeases: number;
  }[];
  usage: { equipmentId: number; authorizedHours: string }[];
};
export function ReportsPage() {
  const today = zonedDay("America/New_York");
  const [query, setQuery] = useState(`from=${today}&to=${today}&period=daily`),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const report = useApi<Report>("/admin/reports?" + query);
  const { reload } = report;
  useEffect(() => {
    const id = window.setInterval(reload, 30000);
    return () => window.clearInterval(id);
  }, [reload]);
  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setQuery(
      new URLSearchParams({
        from: String(f.get("from")),
        to: String(f.get("to")),
        period: String(f.get("period")),
      }).toString(),
    );
  }
  async function download(format: "csv" | "pdf") {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{
        filename: string;
        contentType: string;
        encoding: string;
        content: string;
      }>("/admin/reports/export?" + query + "&format=" + format);
      const content =
        result.encoding === "base64"
          ? Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0))
          : result.content;
      const url = URL.createObjectURL(
        new Blob([content], { type: result.contentType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const d = report.data;
  return (
    <section className="management-page">
      <p className="eyebrow">Operations overview</p>
      <h1>Reports</h1>
      <p>
        Saved receipts, reservations, training attendance, and authenticated
        reader activity. Refreshes every 30 seconds.
      </p>
      <form className="management-search" onSubmit={filter}>
        <label>
          From
          <input name="from" type="date" required defaultValue={today} />
        </label>
        <label>
          Through
          <input name="to" type="date" required defaultValue={today} />
        </label>
        <label>
          Group receipts
          <select name="period">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button className="button">Apply dates</button>
      </form>
      <button className="button button--quiet" onClick={reload}>
        Refresh now
      </button>{" "}
      <button
        className="button button--quiet"
        disabled={busy || !d}
        onClick={() => void download("csv")}
      >
        Export CSV
      </button>{" "}
      <button
        className="button button--quiet"
        disabled={busy || !d}
        onClick={() => void download("pdf")}
      >
        Export PDF
      </button>
      {message ? <p role="alert">{message}</p> : null}
      <LoadState {...report} />
      {d ? (
        <>
          <p>
            Generated {dateTime(d.generatedAt)} · Reporting timezone:{" "}
            {d.timeZone}
          </p>
          <div className="management-grid">
            <section>
              <h2>Recorded revenue</h2>
              <p>
                Net receipts:{" "}
                <strong>
                  {dollars(
                    String(d.revenue.reduce((a, r) => a + Number(r.net), 0)),
                  )}
                </strong>
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Membership / category</th>
                    <th>Method</th>
                    <th>Receipts</th>
                    <th>Gross</th>
                    <th>Refunded</th>
                    <th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {d.revenue.map((r, i) => (
                    <tr key={i}>
                      <td>{r.period}</td>
                      <td>{r.category}</td>
                      <td>{r.method}</td>
                      <td>{r.receipts}</td>
                      <td>{dollars(r.gross)}</td>
                      <td>{dollars(r.refunds)}</td>
                      <td>{dollars(r.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.revenue.length ? (
                <p>No settled receipts in this period.</p>
              ) : null}
            </section>
            <section>
              <h2>Users & compliance</h2>
              <p>
                {d.active.activeUsers} unique checked-in users ·{" "}
                {d.active.approvedCheckIns} approved check-ins
              </p>
              <p>
                {d.compliance.activeAccounts} active accounts ·{" "}
                {d.compliance.restrictedAccounts} restricted accounts ·{" "}
                {d.compliance.expiredTraining} expired active training records
              </p>
              <h3>Current authenticated reader leases</h3>
              {d.live.length ? (
                d.live.map((r, i) => (
                  <p key={i}>
                    {r.kind} {r.resourceId ?? "entrance"}:{" "}
                    {r.activeReaderLeases}
                  </p>
                ))
              ) : (
                <p>No current reader leases.</p>
              )}
            </section>
          </div>
          <h2>Equipment booking utilization</h2>
          <table>
            <thead>
              <tr>
                <th>Machine</th>
                <th>Bookings</th>
                <th>Booked hours</th>
                <th>Calendar-window utilization</th>
                <th>Reader-authorized hours</th>
              </tr>
            </thead>
            <tbody>
              {d.equipment.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.reservations}</td>
                  <td>{e.bookedHours.toFixed(2)}</td>
                  <td>{e.bookedUtilizationPercent.toFixed(1)}%</td>
                  <td>
                    {Number(
                      d.usage.find((u) => u.equipmentId === e.id)
                        ?.authorizedHours ?? 0,
                    ).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>Usage by weekday and hour</summary>
            <table>
              <thead>
                <tr>
                  <th>Machine</th>
                  <th>Weekday</th>
                  <th>Local hour</th>
                  <th>Booked hours</th>
                </tr>
              </thead>
              <tbody>
                {d.patterns.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>
                      {
                        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][
                          r.weekday - 1
                        ]
                      }
                    </td>
                    <td>{r.hour}:00</td>
                    <td>{Number(r.bookedHours).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <h2>Class occupancy & attendance</h2>
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th>Starts</th>
                <th>Status</th>
                <th>Registered / capacity</th>
                <th>Filled</th>
                <th>Verified attendance</th>
              </tr>
            </thead>
            <tbody>
              {d.classes.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td>{dateTime(c.startsAt)}</td>
                  <td>{c.status}</td>
                  <td>
                    {c.enrolled} / {c.capacity}
                  </td>
                  <td>{Number(c.filledPercent).toFixed(1)}%</td>
                  <td>{c.attended}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Room visits</h2>
          {d.rooms.map((r) => (
            <p key={r.id}>
              {r.name}: {r.distinctVisitors} visitors, {r.recordedCheckIns}{" "}
              check-ins; room capacity {r.capacity}
            </p>
          ))}
          <details>
            <summary>Report definitions</summary>
            {d.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
