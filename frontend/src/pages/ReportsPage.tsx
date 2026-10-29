import { TableScroll } from "../components/TableScroll";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "../components/Management";
import { dollars, dateTime, zonedDay } from "../lib/display";
export type Report = {
  period: "daily" | "weekly" | "monthly";
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
  visitsByDay: { day: string; visits: number; people: number }[];
  checkedInToday: { userId: number; name: string; location: string; at: string; method: "nfc" | "portal" }[];
  checkedInTodayCount: number;
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
  memberships: {
    period: string;
    newMembers: number;
    activeMembers: number;
    expiringMembers: number;
    cancelledMembers: number;
  }[];
  notifications: {
    cohorts: Record<
      string,
      {
        eligible: number;
        on_time: number;
        onTimePercent: number | null;
        delivered: number;
        delivery_on_time: number;
        deliveryOnTimePercent: number | null;
        delivery_failed: number;
        failed: number;
        uncertain: number;
        pending: number;
      }
    >;
  };
};
export function ReportsPage() {
  const today = zonedDay("America/New_York");
  const [query, setQuery] = useState(`from=${today}&to=${today}&period=daily`),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const report = useApi<Report>("/admin/reports?" + query, { retainOnReload: true, refreshInterval: 30000 });
  const { reload } = report;

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
          Group results
          <select name="period">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button className="button button--quiet">Apply dates</button>
      </form>
      <div className="report-actions">
        <button
          className="button button--quiet"
          disabled={busy || !d}
          onClick={() => void download("csv")}
        >
          Export CSV
        </button>
        <button
          className="button button--quiet"
          disabled={busy || !d}
          onClick={() => void download("pdf")}
        >
          Export PDF
        </button>
      </div>
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
              <TableScroll label="Recorded revenue">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      <th scope="col">Membership / category</th>
                      <th scope="col">Method</th>
                      <th scope="col" className="table-number">Receipts</th>
                      <th scope="col" className="table-number">Gross</th>
                      <th scope="col" className="table-number">Refunded</th>
                      <th scope="col" className="table-number">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.revenue.map((r, i) => (
                      <tr key={i}>
                        <td>{r.period}</td>
                        <td>{r.category}</td>
                        <td>{r.method}</td>
                        <td className="table-number">{r.receipts}</td>
                        <td className="table-number">{dollars(r.gross)}</td>
                        <td className="table-number">{dollars(r.refunds)}</td>
                        <td className="table-number">{dollars(r.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
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
          <h2>Membership trends</h2>
          <p>
            Distinct people per period. Renewals don't count as new members.
          </p>
          <TableScroll label="Membership trends">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col" className="table-number">New members</th>
                  <th scope="col" className="table-number">Active coverage</th>
                  <th scope="col" className="table-number">Expiring without continuation</th>
                  <th scope="col" className="table-number">Confirmed cancellation requests</th>
                </tr>
              </thead>
              <tbody>
                {d.memberships?.map((row) => (
                  <tr key={row.period}>
                    <td>{row.period}</td>
                    <td className="table-number">{row.newMembers}</td>
                    <td className="table-number">{row.activeMembers}</td>
                    <td className="table-number">{row.expiringMembers}</td>
                    <td className="table-number">{row.cancelledMembers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p>
            Based on current membership records.
          </p>
          <h2>Notification delivery evidence</h2>
          <p>
            Reminder emails due in the selected range, and whether they went out on time.
          </p>
          <TableScroll label="Notification delivery evidence">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Cohort</th>
                  <th scope="col" className="table-number">Eligible deadlines</th>
                  <th scope="col" className="table-number">Accepted on time</th>
                  <th scope="col" className="table-number">Acceptance rate</th>
                  <th scope="col" className="table-number">Delivered on time</th>
                  <th scope="col" className="table-number">Delivery rate</th>
                  <th scope="col" className="table-number">All delivered callbacks</th>
                  <th scope="col" className="table-number">Failed sends / delivery failures / uncertain / pending</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.notifications?.cohorts ?? {}).map(
                  ([key, row]) => (
                    <tr key={key}>
                      <th scope="row">
                        {(
                          {
                            expirationCompliance:
                              "Waiver & training expiration",
                            membershipExpiration: "Membership expiration",
                            other: "Account, billing & other notices",
                          } as Record<string, string>
                        )[key] ?? key}
                      </th>
                      <td className="table-number">{row.eligible}</td>
                      <td className="table-number">{row.on_time}</td>
                      <td className="table-number">
                        {row.onTimePercent === null
                          ? "Not measured"
                          : row.onTimePercent.toFixed(1) + "%"}
                      </td>
                      <td className="table-number">{row.delivery_on_time}</td>
                      <td className="table-number">
                        {row.deliveryOnTimePercent === null
                          ? "Not measured"
                          : row.deliveryOnTimePercent.toFixed(1) + "%"}
                      </td>
                      <td className="table-number">{row.delivered}</td>
                      <td className="table-number">
                        {row.failed} / {row.delivery_failed} / {row.uncertain} /{" "}
                        {row.pending}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </TableScroll>
          <h2>Equipment booking utilization</h2>
          <TableScroll label="Equipment booking utilization">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Machine</th>
                  <th scope="col" className="table-number">Bookings</th>
                  <th scope="col" className="table-number">Booked hours</th>
                  <th scope="col" className="table-number">Calendar-window utilization</th>
                  <th scope="col" className="table-number">Reader-authorized hours</th>
                </tr>
              </thead>
              <tbody>
                {d.equipment.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td className="table-number">{e.reservations}</td>
                    <td className="table-number">{e.bookedHours.toFixed(2)}</td>
                    <td className="table-number">{e.bookedUtilizationPercent.toFixed(1)}%</td>
                    <td className="table-number">
                      {Number(
                        d.usage.find((u) => u.equipmentId === e.id)
                          ?.authorizedHours ?? 0,
                      ).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <details>
            <summary>Usage by weekday and hour</summary>
            <TableScroll label="Usage by weekday and hour">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Machine</th>
                    <th scope="col">Weekday</th>
                    <th scope="col" className="table-number">Local hour</th>
                    <th scope="col" className="table-number">Booked hours</th>
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
                      <td className="table-number">{r.hour}:00</td>
                      <td className="table-number">{Number(r.bookedHours).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </details>
          <h2>Class occupancy & attendance</h2>
          <TableScroll label="Class occupancy and attendance">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Class</th>
                  <th scope="col">Starts</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="table-number">Registered / capacity</th>
                  <th scope="col" className="table-number">Filled</th>
                  <th scope="col" className="table-number">Verified attendance</th>
                </tr>
              </thead>
              <tbody>
                {d.classes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.title}</td>
                    <td>{dateTime(c.startsAt)}</td>
                    <td>{c.status}</td>
                    <td className="table-number">
                      {c.enrolled} / {c.capacity}
                    </td>
                    <td className="table-number">{Number(c.filledPercent).toFixed(1)}%</td>
                    <td className="table-number">{c.attended}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
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
