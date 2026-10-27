import { useState, type FormEvent } from "react";
import { LineChart } from "../components/Charts";
import { LoadState } from "../components/Management";
import { useApi } from "../lib/useApi";
import { dollars, dateTime, zonedDay } from "../lib/display";
import { revenuePoints, shiftDay, type RevenuePeriod } from "../lib/analytics";
import type { Report } from "./ReportsPage";
import "../assets/css/analyticsDashboard.css";
export function AnalyticsDashboardPage() {
  const today = zonedDay("America/New_York");
  const [range, setRange] = useState({
    from: shiftDay(today, -27),
    to: today,
    period: "weekly" as RevenuePeriod,
  });
  const [validation, setValidation] = useState("");
  const report = useApi<Report>("/admin/reports?" + new URLSearchParams(range), { retainOnReload: true, refreshInterval: 30000 });
  const { reload } = report;

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = {
      from: String(form.get("from")),
      to: String(form.get("to")),
      period: String(form.get("period")) as RevenuePeriod,
    };
    try {
      revenuePoints(next.from, next.to, next.period, []);
      setRange(next);
      setValidation("");
    } catch (error) {
      setValidation((error as Error).message);
    }
  }
  const data = report.data;
  const points = data
    ? revenuePoints(data.from, data.to, data.period, data.revenue)
    : [];
  const total = (field: "gross" | "refunds" | "net") =>
    points.reduce((sum, point) => sum + Math.round(point[field] * 100), 0) /
    100;
  return (
    <section className="analytics-dashboard management-page">
      <header>
        <p className="eyebrow">Operations overview</p>
        <h2>Analytics dashboard</h2>
        <p>
          Recorded receipts, check-ins and class registrations. Refreshes every
          30 seconds.
        </p>
      </header>
      <form className="management-search" onSubmit={filter}>
        <label>
          From
          <input name="from" type="date" required defaultValue={range.from} />
        </label>
        <label>
          Through
          <input name="to" type="date" required defaultValue={range.to} />
        </label>
        <label>
          Group receipts
          <select name="period" defaultValue={range.period}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button className="button">Apply dates</button>
      </form>
      {validation ? <p role="alert">{validation}</p> : null}
      <button className="button button--quiet" onClick={reload}>
        Refresh analytics
      </button>
      <LoadState {...report} />
      {data ? (
        <>
          <p>
            Generated {dateTime(data.generatedAt)} · Reporting timezone:{" "}
            {data.timeZone}
          </p>
          <div className="analytics-layout">
            <article className="panel analytics-revenue">
              <h3>Recorded revenue</h3>
              <p>
                Paid receipts for memberships, day passes and studio rentals.
              </p>
              <dl className="analytics-totals">
                <div>
                  <dt>Gross receipts</dt>
                  <dd>{dollars(String(total("gross")))}</dd>
                </div>
                <div>
                  <dt>Refunds</dt>
                  <dd>{dollars(String(total("refunds")))}</dd>
                </div>
                <div>
                  <dt>Net receipts</dt>
                  <dd>{dollars(String(total("net")))}</dd>
                </div>
              </dl>
              <h4>Gross receipts by period</h4>
              <LineChart
                values={points.map((point) => point.gross)}
                labels={points.map((point, index) =>
                  index % Math.ceil(points.length / 6) === 0 ||
                  index === points.length - 1
                    ? point.period
                    : "",
                )}
                formatTick={(value) =>
                  new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(value)
                }
                max={Math.max(1, ...points.map((point) => point.gross))}
              />
              {!data.revenue.length ? (
                <p>No settled receipts in this period.</p>
              ) : null}
              <div className="analytics-table">
                <table>
                  <caption>Revenue by period (period starting date)</caption>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Receipts</th>
                      <th>Gross</th>
                      <th>Refunds</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.period}>
                        <th scope="row">{point.period}</th>
                        <td>{point.receipts}</td>
                        <td>{dollars(String(point.gross))}</td>
                        <td>{dollars(String(point.refunds))}</td>
                        <td>{dollars(String(point.net))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
            <aside className="panel analytics-activity">
              <h3>Recorded activity</h3>
              <p>
                <strong>{data.active.activeUsers}</strong> unique checked-in
                users in the selected period · {data.active.approvedCheckIns}{" "}
                approved check-ins
              </p>
              <h4>Current authenticated reader leases</h4>
              {data.live.length ? (
                <ul>
                  {data.live.map((item) => (
                    <li key={`${item.kind}-${item.resourceId}`}>
                      {item.kind} {item.resourceId ?? "entrance"}:{" "}
                      {item.activeReaderLeases} active reader leases
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No current reader leases.</p>
              )}
              <p>
                Visits count people who tapped in at a reader.
              </p>
              <h3>Classes in the selected period</h3>
              {data.classes.length ? (
                <ul className="analytics-classes">
                  {data.classes.map((item) => (
                    <li key={item.id}>
                      <h4>{item.title}</h4>
                      <p>
                        {dateTime(item.startsAt)} · {item.status}
                      </p>
                      <p>
                        {item.enrolled} / {item.capacity} enrolled ·{" "}
                        {item.attended} verified attendees
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No classes in this period.</p>
              )}
            </aside>
          </div>
          <details>
            <summary>Report definitions</summary>
            {data.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
