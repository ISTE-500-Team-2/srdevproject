import {
  CalendarDays,
  CircleDollarSign,
  DoorOpen,
  Gauge,
  GraduationCap,
  Info,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { LoadState } from "../components/Management";
import { useApi } from "../lib/useApi";
import { dateTime, dollars, statusLabel, timeOnly, zonedDay } from "../lib/display";
import { revenuePoints, shiftDay, type RevenuePeriod, type RevenuePoint } from "../lib/analytics";
import type { Report } from "./ReportsPage";
import "../assets/css/analyticsDashboard.css";

type Range = { from: string; to: string; period: RevenuePeriod };
type Preset = "week" | "month" | "30" | "90" | "custom";

const ZONE = "America/New_York";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom dates" },
];

/** "Eastern Time" rather than "America/New_York". */
function zoneName(zone: string) {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? zone
    );
  } catch {
    return zone;
  }
}
const dayLabel = (day: string) =>
  new Date(day + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

function presetRange(preset: Exclude<Preset, "custom">, today: string) {
  if (preset === "week") {
    const weekday = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;
    return { from: shiftDay(today, -weekday), to: today };
  }
  if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
  return { from: shiftDay(today, preset === "30" ? -29 : -89), to: today };
}

/** The same number of days immediately before the range, for comparisons. */
function previousRange(range: Range): Range {
  const length = daysBetween(range.from, range.to);
  return { ...range, from: shiftDay(range.from, -length), to: shiftDay(range.from, -1) };
}

const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 ? 2 : 0,
  }).format(value);
const sum = (points: RevenuePoint[], field: "gross" | "refunds" | "net" | "receipts") =>
  points.reduce((total, point) => total + Math.round(point[field] * 100), 0) / 100;

function classStats(classes: Report["classes"]) {
  const held = classes.filter((c) => c.status !== "cancelled");
  const seats = held.reduce((n, c) => n + c.capacity, 0);
  const filled = held.reduce((n, c) => n + c.enrolled, 0);
  return { held: held.length, seats, filled, rate: seats ? filled / seats : null };
}

function Delta({ value, format, unit }: { value: number | null; format: (n: number) => string; unit: string }) {
  if (value === null) return <span className="kpi__delta">No earlier data</span>;
  if (value === 0) return <span className="kpi__delta">Same as {unit}</span>;
  const Icon = value > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`kpi__delta kpi__delta--${value > 0 ? "up" : "down"}`}>
      <Icon aria-hidden="true" /> {value > 0 ? "+" : "−"}
      {format(Math.abs(value))} vs {unit}
    </span>
  );
}

function Kpi({ label, Icon, value, children }: { label: string; Icon: LucideIcon; value: string; children: React.ReactNode }) {
  return (
    <article className="kpi">
      <span className="kpi__label">
        <Icon aria-hidden="true" /> {label}
      </span>
      <strong>{value}</strong>
      {children}
    </article>
  );
}

/** A tidy axis top: 1, 2, 2.5 or 5 times a power of ten. */
function niceMax(value: number) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

function periodLabel(point: RevenuePoint, period: RevenuePeriod) {
  const date = new Date(point.period + "T12:00:00Z");
  return period === "monthly"
    ? date.toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

function RevenueBars({ points, period }: { points: RevenuePoint[]; period: RevenuePeriod }) {
  const top = niceMax(Math.max(0, ...points.map((p) => p.gross)));
  const every = Math.ceil(points.length / 8);
  return (
    <div className="revenue-bars">
      <div className="revenue-bars__axis" aria-hidden="true">
        {[1, 0.75, 0.5, 0.25, 0].map((f) => (
          <span key={f}>{money(top * f)}</span>
        ))}
      </div>
      <div className="revenue-bars__plot">
        {points.map((point, i) => {
          const label = periodLabel(point, period);
          const detail = `${label}: ${money(point.net)} paid, ${point.receipts} ${point.receipts === 1 ? "receipt" : "receipts"}${point.refunds ? `, ${money(point.refunds)} refunded` : ""}`;
          return (
            <div key={point.period} className="revenue-bars__col" tabIndex={0} aria-label={detail}>
              <span className="revenue-bars__tip" aria-hidden="true">
                <b>{money(point.net)} paid</b>
                {point.receipts} {point.receipts === 1 ? "receipt" : "receipts"}
                {point.refunds ? ` · ${money(point.refunds)} refunded` : " · no refunds"}
              </span>
              {point.gross ? (
                <>
                  {point.refunds ? (
                    <i className="revenue-bars__refund" style={{ height: `${(point.refunds / top) * 100}%` }} />
                  ) : null}
                  <i className="revenue-bars__paid" style={{ height: `${(point.net / top) * 100}%` }} />
                </>
              ) : (
                <i className="revenue-bars__zero" />
              )}
              <small aria-hidden="true">{i % every === 0 || i === points.length - 1 ? label : ""}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AnalyticsDashboardPage() {
  const today = zonedDay(ZONE);
  const [preset, setPreset] = useState<Preset>("30");
  const [range, setRange] = useState<Range>({ ...presetRange("30", today), period: "weekly" });
  const [validation, setValidation] = useState("");
  const report = useApi<Report>("/admin/reports?" + new URLSearchParams(range), {
    retainOnReload: true,
    refreshInterval: 30000,
  });
  const previous = useApi<Report>("/admin/reports?" + new URLSearchParams(previousRange(range)), {
    retainOnReload: true,
  });

  const apply = (next: Range) => {
    try {
      revenuePoints(next.from, next.to, next.period, []);
      setRange(next);
      setValidation("");
    } catch (error) {
      setValidation((error as Error).message);
    }
  };

  const data = report.data;
  const points = data ? revenuePoints(data.from, data.to, data.period, data.revenue) : [];
  const before = previous.data;
  const beforePoints = before ? revenuePoints(before.from, before.to, before.period, before.revenue) : [];
  const unit = preset === "week" ? "last week" : preset === "month" ? "last month" : "the previous period";
  const classes = data ? classStats(data.classes) : null;
  const classesBefore = before ? classStats(before.classes) : null;
  const visits = data?.visitsByDay ?? [];
  const busiest = Math.max(1, ...visits.map((v) => v.visits));
  const checkedIn = data?.checkedInToday ?? [];

  return (
    <section className="analytics-dashboard management-page">
      <header className="analytics-head">
        <h2>Analytics</h2>
        <div className="analytics-controls">
          <label className="analytics-range">
            <CalendarDays aria-hidden="true" />
            <span className="sr-only">Date range</span>
            <select
              value={preset}
              aria-label="Date range"
              onChange={(e) => {
                const value = e.target.value as Preset;
                setPreset(value);
                if (value !== "custom") apply({ ...range, ...presetRange(value, today) });
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="analytics-period" role="radiogroup" aria-label="Group revenue by">
            {(["daily", "weekly", "monthly"] as RevenuePeriod[]).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={range.period === p}
                onClick={() => apply({ ...range, period: p })}
              >
                {statusLabel(p)}
              </button>
            ))}
          </div>
        </div>
      </header>
      {preset === "custom" ? (
        <div className="analytics-custom">
          <label>
            From
            <input type="date" value={range.from} max={range.to} onChange={(e) => apply({ ...range, from: e.target.value })} />
          </label>
          <label>
            Through
            <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => apply({ ...range, to: e.target.value })} />
          </label>
          <small>Up to 93 days.</small>
        </div>
      ) : null}
      {validation ? <p role="alert" className="form-error">{validation}</p> : null}
      <LoadState {...report} loading={report.loading && !report.data} />

      {data && classes ? (
        <>
          <div className="kpis" aria-label="Headline numbers">
            <Kpi label="Net revenue" Icon={CircleDollarSign} value={money(sum(points, "net"))}>
              <Delta value={before ? sum(points, "net") - sum(beforePoints, "net") : null} format={money} unit={unit} />
            </Kpi>
            <Kpi label="Visits" Icon={DoorOpen} value={String(data.active.approvedCheckIns)}>
              <Delta
                value={before ? data.active.approvedCheckIns - before.active.approvedCheckIns : null}
                format={(n) => String(n)}
                unit={unit}
              />
            </Kpi>
            <Kpi label="Classes held" Icon={GraduationCap} value={String(classes.held)}>
              <Delta value={classesBefore ? classes.held - classesBefore.held : null} format={(n) => String(n)} unit={unit} />
            </Kpi>
            <Kpi
              label="Class fill rate"
              Icon={Gauge}
              value={classes.rate === null ? "—" : `${Math.round(classes.rate * 100)}%`}
            >
              {classes.rate === null ? (
                <span className="kpi__delta">No classes in this period</span>
              ) : (
                <Delta
                  value={classesBefore?.rate == null ? null : Math.round(classes.rate * 100) - Math.round(classesBefore.rate * 100)}
                  format={(n) => `${n} pts`}
                  unit={unit}
                />
              )}
            </Kpi>
          </div>

          <div className="analytics-layout">
            <article className="panel analytics-revenue">
              <div className="analytics-panel-head">
                <h3>Revenue by {range.period === "daily" ? "day" : range.period === "weekly" ? "week" : "month"}</h3>
                <span className="analytics-legend" aria-hidden="true">
                  <span><i className="is-paid" />Paid</span>
                  <span><i className="is-refund" />Refunded</span>
                </span>
              </div>
              <dl className="analytics-totals">
                <div><dt>Gross receipts</dt><dd>{dollars(String(sum(points, "gross")))}</dd></div>
                <div><dt>Refunds</dt><dd>{dollars(String(sum(points, "refunds")))}</dd></div>
                <div><dt>Net receipts</dt><dd>{dollars(String(sum(points, "net")))}</dd></div>
              </dl>
              {data.revenue.length ? (
                <RevenueBars points={points} period={range.period} />
              ) : (
                <p className="analytics-empty">No paid receipts in this period.</p>
              )}
              <details className="analytics-table">
                <summary>Show as table</summary>
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
              </details>
            </article>

            <aside className="panel analytics-activity">
              <div className="analytics-panel-head">
                <h3>Checked in today</h3>
                {checkedIn.length ? <span className="analytics-live">{checkedIn.length} {checkedIn.length === 1 ? "person" : "people"}</span> : null}
              </div>
              {checkedIn.length ? (
                <ul className="analytics-people">
                  {checkedIn.slice(0, 6).map((person) => (
                    <li key={person.userId}>
                      <span className="analytics-people__avatar" aria-hidden="true">
                        {person.name.split(" ").map((part) => part.at(0)).join("").slice(0, 2)}
                      </span>
                      <span>
                        <b>{person.name}</b>
                        <small>{person.location} · {timeOnly(person.at)}</small>
                      </span>
                      <span className="analytics-people__method">{person.method === "nfc" ? "NFC" : "Site"}</span>
                    </li>
                  ))}
                  {checkedIn.length > 6 ? <li className="analytics-people__more">+{checkedIn.length - 6} more</li> : null}
                </ul>
              ) : (
                <p className="analytics-empty">Nobody has checked in yet today.</p>
              )}
              <div className="analytics-divider" />
              <div className="analytics-panel-head">
                <h3>Visits per day</h3>
                <span className="analytics-muted">{data.active.approvedCheckIns} visits · {data.active.activeUsers} people</span>
              </div>
              <div className="visits-strip" role="img" aria-label={`Visits per day from ${dayLabel(data.from)} to ${dayLabel(data.to)}; most in one day: ${visits.some((v) => v.visits) ? busiest : 0}`}>
                {visits.map((v) => (
                  <i
                    key={v.day}
                    title={`${dayLabel(v.day)}: ${v.visits} ${v.visits === 1 ? "visit" : "visits"}`}
                    className={v.visits ? "" : "is-empty"}
                    style={{ height: v.visits ? `${Math.max(8, (v.visits / busiest) * 100)}%` : undefined }}
                  />
                ))}
              </div>
              <div className="visits-strip__ends" aria-hidden="true">
                <span>{dayLabel(data.from)}</span>
                <span>{data.to === today ? "Today" : dayLabel(data.to)}</span>
              </div>
            </aside>
          </div>

          <section className="panel analytics-classes">
            <div className="analytics-panel-head">
              <h3>Classes in this period</h3>
              {classes.held ? (
                <span className="analytics-muted">
                  {classes.held} {classes.held === 1 ? "class" : "classes"} · {classes.filled} of {classes.seats} seats filled
                </span>
              ) : null}
            </div>
            {data.classes.length ? (
              <ul>
                {data.classes.map((item) => {
                  const past = new Date(item.startsAt).getTime() < Date.now();
                  return (
                    <li key={item.id} className={item.status === "cancelled" ? "is-cancelled" : ""}>
                      <span>
                        <b>{item.title}</b>
                        <small>{dateTime(item.startsAt)} · {statusLabel(item.status)}</small>
                      </span>
                      <span className="analytics-fill" aria-hidden="true">
                        <i style={{ width: `${Math.min(100, (item.enrolled / Math.max(1, item.capacity)) * 100)}%` }} />
                      </span>
                      <span className="analytics-fill__count">
                        {item.enrolled} / {item.capacity}
                        {past && item.status !== "cancelled" ? ` · ${item.attended} came` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="analytics-empty">No classes in this period.</p>
            )}
          </section>

          <footer className="analytics-foot">
            <span>
              Updated {timeOnly(data.generatedAt)} · {zoneName(data.timeZone)} · refreshes every 30 seconds
            </span>
            <details>
              <summary>
                <Info aria-hidden="true" /> How these numbers are counted
              </summary>
              {data.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </details>
          </footer>
        </>
      ) : null}
    </section>
  );
}
