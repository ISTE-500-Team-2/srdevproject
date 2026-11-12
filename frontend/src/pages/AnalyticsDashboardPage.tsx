import { TableScroll } from "../components/TableScroll";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  CircleDollarSign,
  DoorOpen,
  Gauge,
  Info,
  TrendingDown,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LoadState } from "../components/Management";
import { useApi } from "../lib/useApi";
import { dollars, statusLabel, timeOnly, zonedDay } from "../lib/display";
import {
  earlierTotal,
  periodCoverage,
  revenuePoints,
  shiftDay,
  visitPoints,
  weekdayCounts,
  type RevenuePeriod,
  type RevenuePoint,
} from "../lib/analytics";
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

/**
 * What the range is compared with. "This week" through Tuesday compares with
 * Monday and Tuesday of last week, not with the weekend just before it; "This
 * month" through the 10th compares with the 1st to the 10th of last month.
 * Always by day, so each bar can be compared with exactly its own days.
 */
function previousRange(range: { from: string; to: string }, preset: Preset): Range {
  if (preset === "week") return { from: shiftDay(range.from, -7), to: shiftDay(range.to, -7), period: "daily" };
  if (preset === "month") {
    const start = new Date(range.from + "T00:00:00Z");
    start.setUTCMonth(start.getUTCMonth() - 1);
    const from = start.toISOString().slice(0, 10);
    const sameDay = shiftDay(from, Number(range.to.slice(8)) - 1);
    const monthEnd = shiftDay(range.from, -1);
    return { from, to: sameDay < monthEnd ? sameDay : monthEnd, period: "daily" };
  }
  const length = daysBetween(range.from, range.to);
  return { from: shiftDay(range.from, -length), to: shiftDay(range.from, -1), period: "daily" };
}

/** "vs last week" on the headline cards; "a week earlier" on a single bar. */
function comparison(preset: Preset, range: { from: string; to: string }) {
  if (preset === "week") return { unit: "last week", earlier: "a week earlier" };
  if (preset === "month") return { unit: "last month", earlier: "a month earlier" };
  const length = daysBetween(range.from, range.to);
  return { unit: `the previous ${length} days`, earlier: `${length} days earlier` };
}

/** Day-by-day totals from the comparison report, in cents for money. */
function byDay<T>(rows: T[], day: (row: T) => string, value: (row: T) => number) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(day(row), (totals.get(day(row)) ?? 0) + value(row));
  return totals;
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
  const running = classes.filter((c) => c.status !== "cancelled");
  const seats = running.reduce((n, c) => n + c.capacity, 0);
  const filled = running.reduce((n, c) => n + c.enrolled, 0);
  // Attendance only means something once a class has started.
  const held = running.filter((c) => Date.parse(c.startsAt) < Date.now());
  const booked = held.reduce((n, c) => n + c.enrolled, 0);
  const came = held.reduce((n, c) => n + c.attended, 0);
  return { held: held.length, seats, filled, rate: seats ? filled / seats : null, booked, came };
}

function Delta({
  value,
  previous,
  format,
  unit,
}: {
  value: number | null;
  previous?: number;
  format: (n: number) => string;
  unit: string;
}) {
  if (value === null) return <span className="kpi__delta">No earlier data</span>;
  if (value === 0) return <span className="kpi__delta">Same as {unit}</span>;
  // "+$998 vs the previous period" says less than "$0 in the previous period".
  if (previous === 0)
    return <span className="kpi__delta">{format(0)} {unit.startsWith("the ") ? `in ${unit}` : unit}</span>;
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

/** A tidy axis top: four equal, round steps that just clear the tallest bar. */
function niceMax(value: number, whole = false) {
  if (value <= 0) return whole ? 4 : 100;
  const quarter = value / 4;
  const power = 10 ** Math.floor(Math.log10(quarter));
  const top = 4 * ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => step * power >= quarter) ?? 10) * power;
  // Counts need whole-number gridlines: 1, 2, 3, 4 rather than 0.8, 1.6...
  return whole ? Math.max(4, Math.ceil(top / 4) * 4) : top;
}

function periodLabel(start: string, period: RevenuePeriod) {
  const date = new Date(start + "T12:00:00Z");
  return period === "monthly"
    ? date.toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Week of Oct 26", "Nov 2", or "Nov 2026": what one bar stands for. */
function periodName(start: string, period: RevenuePeriod) {
  return period === "weekly" ? `Week of ${periodLabel(start, period)}` : periodLabel(start, period);
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Every nth date plus the last, skipping a regular one that would crowd the last. */
const showTick = (i: number, n: number, every: number) => i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2);

type Bar = {
  key: string;
  tick: string;
  /** Stacked bottom to top. */
  segments: { value: number; className: string }[];
  /** "2 of 7 days" when the range covers only part of the period. */
  partial: string | null;
  /** The same days one comparison period earlier, drawn as a line across the bar. */
  earlier?: number;
  label: string;
  detail: ReactNode;
};

/**
 * Bars over time, shared by every chart on the page so they all read the same way.
 * Details show in a line under the chart (hover, focus or tap), so nothing
 * covers the bars and it works on touch screens. The chart is one Tab stop;
 * arrow keys move between bars.
 */
function PeriodBars({
  name,
  bars,
  format,
  whole = false,
  grouped = false,
  short = false,
}: {
  name: string;
  bars: Bar[];
  format: (n: number) => string;
  whole?: boolean;
  /** Side by side instead of stacked, for two counts that don't add up to anything. */
  grouped?: boolean;
  short?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  // The bar that takes focus when tabbing in: the latest one until another is chosen.
  const [cursor, setCursor] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const heights = bars.map((bar) =>
    grouped ? Math.max(0, ...bar.segments.map((s) => s.value)) : bar.segments.reduce((sum, s) => sum + s.value, 0),
  );
  const top = niceMax(Math.max(0, ...heights, ...bars.map((bar) => bar.earlier ?? 0)), whole);
  const every = Math.ceil(bars.length / 8);
  const shown = active === null ? null : bars[active];
  const partial = bars.some((bar) => bar.partial);
  const focusable = Math.min(cursor ?? bars.length - 1, bars.length - 1);
  const move = (to: number) => {
    const next = Math.min(bars.length - 1, Math.max(0, to));
    setCursor(next);
    (plot.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  const bar = (value: number, className: string) => (
    <i key={className} className={`period-bars__seg ${className}`} style={{ height: `${(value / top) * 100}%` }} />
  );
  return (
    <>
      <div className="period-chart" role="region" aria-label={name}>
        {/* Wide bars can center every date label; narrow ones keep the endpoints inside the chart. */}
        <div className={`period-bars${every === 1 ? " period-bars--sparse" : ""}${short ? " period-bars--short" : ""}`}>
          <div className="period-bars__axis" aria-hidden="true">
            {[1, 0.75, 0.5, 0.25, 0].map((f) => (
              <span key={f} style={{ bottom: `${f * 100}%` }}>
                {format(top * f)}
              </span>
            ))}
          </div>
          <div
            ref={plot}
            className="period-bars__plot"
            role="listbox"
            aria-label={`${name}, one bar per period. Use the arrow keys to move between bars.`}
            onMouseLeave={() => setActive(null)}
            // Narrow daily bars are hard to hit; anywhere over the plot picks the nearest one.
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setActive(Math.min(bars.length - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * bars.length))));
            }}
            onKeyDown={(e) => {
              const index = active ?? focusable;
              const to = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: bars.length - 1 }[e.key];
              if (to === undefined) return;
              e.preventDefault();
              move(to);
            }}
          >
            {bars.map((item, i) => (
              <div
                key={item.key}
                className={`period-bars__col${i === active ? " is-active" : ""}${item.partial ? " is-partial" : ""}`}
                role="option"
                aria-selected={i === active}
                tabIndex={i === focusable ? 0 : -1}
                aria-label={item.label}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => {
                  setCursor(i);
                  setActive(i);
                }}
              >
                {grouped ? (
                  <span className="period-bars__group">
                    {item.segments.map((s) => (s.value ? bar(s.value, s.className) : <i key={s.className} className="period-bars__zero" />))}
                  </span>
                ) : heights[i] ? (
                  [...item.segments].reverse().map((s) => (s.value ? bar(s.value, s.className) : null))
                ) : (
                  <i className="period-bars__zero" />
                )}
                {item.earlier !== undefined ? (
                  <i className="period-bars__earlier" aria-hidden="true" style={{ bottom: `${(item.earlier / top) * 100}%` }} />
                ) : null}
                <small aria-hidden="true">{showTick(i, bars.length, every) ? item.tick : ""}</small>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Screen readers get the same details from each bar's label. */}
      <p className="period-readout" aria-hidden="true">
        {shown ? (
          <>
            {shown.detail}
            {shown.partial ? <span className="period-readout__partial">Partial: {shown.partial} in range</span> : null}
          </>
        ) : (
          <span className="period-readout__hint">
            Hover over or tap a bar to see its numbers.{partial ? " Striped bars are only partly in the date range." : ""}
          </span>
        )}
      </p>
    </>
  );
}

function coverage(start: string, period: RevenuePeriod, from: string, to: string) {
  const { days, total } = periodCoverage(start, period, from, to);
  return days < total ? `${days} of ${total} days` : null;
}

/** How a bar compares with the same days earlier, for its label and details line. */
type Earlier = { phrase: string; value: (start: string) => number };

/** Net only: what the space actually kept. Refunds are in the totals and each bar's details. */
function revenueBars(points: RevenuePoint[], period: RevenuePeriod, from: string, to: string, earlier?: Earlier): Bar[] {
  return points.map((point) => {
    const partial = coverage(point.period, period, from, to);
    const name = periodName(point.period, period);
    const then = earlier ? earlier.value(point.period) : undefined;
    return {
      key: point.period,
      tick: periodLabel(point.period, period),
      segments: [{ value: point.net, className: "is-net" }],
      partial,
      earlier: then,
      label: `${name}${partial ? ` (partial: ${partial})` : ""}: ${money(point.net)} net, ${count(point.receipts, "receipt")}${point.refunds ? `, ${money(point.refunds)} refunded` : ""}${then === undefined ? "" : `; ${earlier!.phrase}: ${money(then)}`}`,
      detail: (
        <span className="period-readout__line">
          <span className="period-readout__name">{name}</span>
          <span><i className="is-net" />{money(point.net)} net</span>
          {then === undefined ? null : <span><i className="is-earlier" />{capitalize(earlier!.phrase)}: {money(then)}</span>}
          {point.refunds ? <span>{money(point.refunds)} refunded</span> : null}
          <span>{count(point.receipts, "receipt")}</span>
        </span>
      ),
    };
  });
}

/** Net revenue by plan or product, largest first; the long tail folds into one row. */
function SourceList({ rows }: { rows: Report["revenue"] }) {
  const cents = new Map<string, number>();
  for (const row of rows) cents.set(row.category, (cents.get(row.category) ?? 0) + Math.round(Number(row.net) * 100));
  const sorted = [...cents].filter(([, net]) => net > 0).sort((a, b) => b[1] - a[1]);
  const shown = sorted.length > 5 ? [...sorted.slice(0, 4), ["Everything else", sorted.slice(4).reduce((n, [, v]) => n + v, 0)] as [string, number]] : sorted;
  const total = sorted.reduce((n, [, v]) => n + v, 0);
  const largest = Math.max(1, ...shown.map(([, v]) => v));
  return shown.length ? (
    <ul className="analytics-breakdown">
      {shown.map(([name, net]) => (
        <li key={name}>
          <span className="analytics-breakdown__name">{name}</span>
          <span className="analytics-breakdown__value">
            {money(net / 100)} <small>{Math.round((net / total) * 100)}%</small>
          </span>
          <span className="analytics-breakdown__bar" aria-hidden="true">
            <i className="is-net" style={{ width: `${(net / largest) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="analytics-empty">Everything was refunded.</p>
  );
}

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);
const oneDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, "");

/**
 * Which days of the week are busy: what staffing and class times hinge on.
 * Averages, because 30 days holds five of some weekdays and four of the rest.
 */
function WeekdayList({ days, from, to }: { days: Report["visitsByDay"]; from: string; to: string }) {
  const totals = WEEKDAYS.map(() => 0);
  for (const { day, visits } of days) totals[(new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7] += visits;
  const counts = weekdayCounts(from, to);
  const averages = totals.map((total, i) => (counts[i] ? total / counts[i] : 0));
  const busiest = Math.max(...averages);
  return (
    <ul className="analytics-breakdown analytics-breakdown--compact">
      {WEEKDAYS.map((name, i) => (
        <li key={name} className={averages[i] === busiest && busiest > 0 ? "is-top" : ""}>
          <span className="analytics-breakdown__name">{name}</span>
          <span className="analytics-breakdown__value" title={`${count(totals[i], "visit")} over ${count(counts[i], name)}`}>
            {oneDecimal(averages[i])}
          </span>
          <span className="analytics-breakdown__bar" aria-hidden="true">
            <i className="is-visits" style={{ width: `${busiest ? (averages[i] / busiest) * 100 : 0}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Series swatches plus, when there is a comparison, the line for the same days earlier. */
function Legend({ series, earlier = null }: { series: [className: string, label: string][]; earlier?: string | null }) {
  return (
    <span className="analytics-legend" aria-hidden="true">
      {series.map(([className, label]) => (
        <span key={className}>
          <i className={className} />
          {label}
        </span>
      ))}
      {earlier ? (
        <span>
          <i className="is-earlier" />
          {capitalize(earlier)}
        </span>
      ) : null}
    </span>
  );
}

/** A quiet link to the page where the numbers behind a card can be acted on. */
function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="analytics-link" to={to}>
      {children}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

const CLASS_PREVIEW = 6;
const classTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ZONE });

/** Classes only have "scheduled" or "cancelled"; whether one was held depends on the date. */
function classState(item: Report["classes"][number]) {
  if (item.status === "cancelled") return "Cancelled";
  return Date.parse(item.startsAt) < Date.now() ? "Held" : "Upcoming";
}

/** The newest classes in the range, two per row; the rest stay one click away. */
function ClassList({ items, stats }: { items: Report["classes"]; stats: ReturnType<typeof classStats> }) {
  const [showAll, setShowAll] = useState(false);
  const newest = [...items].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const shown = showAll ? newest : newest.slice(0, CLASS_PREVIEW);
  return (
    <section className="panel analytics-classes">
      <div className="analytics-panel-head">
        <h3>Classes in this period</h3>
        <MoreLink to="/classes">Open Classes</MoreLink>
      </div>
      {/* Booked is how full classes were; came is whether people showed up once booked. */}
      <dl className="analytics-totals">
        <div><dt>Held</dt><dd>{stats.held}</dd></div>
        {stats.seats ? <div><dt>Seats filled</dt><dd>{stats.filled} of {stats.seats}</dd></div> : null}
        {stats.booked ? (
          <div>
            <dt>Showed up</dt>
            <dd>
              {stats.came} of {stats.booked} · {Math.round((stats.came / stats.booked) * 100)}%
            </dd>
          </div>
        ) : null}
      </dl>
      <ul>
        {shown.map((item) => {
          const state = classState(item);
          return (
            <li key={item.id} className={state === "Cancelled" ? "is-cancelled" : ""}>
              <span className="analytics-class__name">
                <b>{item.title}</b>
                <small>{classTime(item.startsAt)} · {state}</small>
              </span>
              <span className="analytics-fill" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (item.enrolled / Math.max(1, item.capacity)) * 100)}%` }} />
              </span>
              <span className="analytics-fill__count">
                {item.enrolled} / {item.capacity}
                {state === "Held" ? <small>{item.attended} came</small> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {newest.length > CLASS_PREVIEW ? (
        <button type="button" className="analytics-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${newest.length} classes`}
        </button>
      ) : null}
    </section>
  );
}

export function AnalyticsDashboardPage() {
  const today = zonedDay(ZONE);
  const [preset, setPreset] = useState<Preset>("30");
  const [range, setRange] = useState<Range>({ ...presetRange("30", today), period: "weekly" });
  const [draft, setDraft] = useState(range);
  const [validation, setValidation] = useState("");
  const report = useApi<Report>("/admin/reports?" + new URLSearchParams(range), {
    retainOnReload: true,
    refreshInterval: 30000,
  });
  const previous = useApi<Report>("/admin/reports?" + new URLSearchParams(previousRange(range, preset)), {
    retainOnReload: true,
  });

  const apply = (next: Range) => {
    // Permit intermediate edits while keeping requests on the last valid range.
    setDraft(next);
    try {
      revenuePoints(next.from, next.to, next.period, []);
      setRange(next);
      setValidation("");
    } catch (error) {
      setValidation((error as Error).message);
    }
  };

  const data = report.data;
  const period = data?.period ?? range.period;
  const points = data ? revenuePoints(data.from, data.to, period, data.revenue) : [];
  // While a new range loads, either report may still be the old one: compare only a matching pair.
  const expected = data ? previousRange(data, preset) : null;
  const before =
    previous.data && expected && previous.data.from === expected.from && previous.data.to === expected.to ? previous.data : undefined;
  const beforePoints = before ? revenuePoints(before.from, before.to, before.period, before.revenue) : [];
  const { unit, earlier: earlierPhrase } = comparison(preset, data ?? range);
  const inUnit = unit.startsWith("the ") ? `in ${unit}` : unit;
  const earlier = (daily: Map<string, number>, scale = 1): Earlier | undefined =>
    before && data
      ? { phrase: earlierPhrase, value: (start) => earlierTotal(start, period, data, before, daily) / scale }
      : undefined;
  const members = data?.memberships ?? [];
  const joined = members.reduce((n, row) => n + row.newMembers, 0);
  const joinedBefore = (before?.memberships ?? []).reduce((n, row) => n + row.newMembers, 0);
  const netByDay = byDay(before?.revenue ?? [], (row) => row.period, (row) => Math.round(Number(row.net) * 100));
  const visitsByDayBefore = byDay(before?.visitsByDay ?? [], (row) => row.day, (row) => row.visits);
  const visitsEarlier = earlier(visitsByDayBefore);
  const cancelled = members.reduce((n, row) => n + row.cancelledMembers, 0);
  const ended = members.reduce((n, row) => n + row.expiringMembers, 0);
  const classes = data ? classStats(data.classes) : null;
  const classesBefore = before ? classStats(before.classes) : null;
  const visits = data?.visitsByDay ?? [];
  const busiest = Math.max(0, ...visits.map((v) => v.visits));
  const peak = busiest ? visits.find((v) => v.visits === busiest) : undefined;
  // The full total, not the length of the capped recent list.
  const checkedInCount = data?.checkedInTodayCount ?? data?.checkedInToday.length ?? 0;
  const unitWord = period === "daily" ? "day" : period === "weekly" ? "week" : "month";
  const hasRevenue = sum(points, "gross") > 0;

  return (
    <section className="analytics-dashboard management-page">
      <header className="analytics-head">
        <div><p className="admin-page-eyebrow">Records</p><h1 className="admin-title">Analytics</h1></div>
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
                if (value !== "custom") apply({ ...draft, ...presetRange(value, today) });
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <ChevronDown className="analytics-range__chevron" aria-hidden="true" />
          </label>
          {/* Groups both charts, so it sits with the date range. */}
          <div className="analytics-period" role="radiogroup" aria-label="Group charts by">
            {(["daily", "weekly", "monthly"] as RevenuePeriod[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={draft.period === p} onClick={() => apply({ ...draft, period: p })}>
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
            <input type="date" value={draft.from} max={today} onChange={(e) => apply({ ...draft, from: e.target.value })} />
          </label>
          <label>
            Through
            <input type="date" value={draft.to} max={today} onChange={(e) => apply({ ...draft, to: e.target.value })} />
          </label>
          <small>Up to 93 days.</small>
        </div>
      ) : null}
      {validation ? <p role="alert" className="form-error">{validation}</p> : null}
      <LoadState {...report} loading={report.loading && !report.data} />

      {data && classes ? (
        <>
          {/* Live numbers ignore the date range, so they sit apart from the headline cards. */}
          <p className="analytics-now">
            <span>
              <b>{data.compliance.activeMemberships}</b> active {data.compliance.activeMemberships === 1 ? "membership" : "memberships"}
            </span>
            <span>
              <b>{checkedInCount}</b> checked in today
            </span>
          </p>

          <div className="kpis" aria-label="Headline numbers">
            <Kpi label="Net revenue" Icon={CircleDollarSign} value={money(sum(points, "net"))}>
              <Delta
                value={before ? sum(points, "net") - sum(beforePoints, "net") : null}
                previous={before ? sum(beforePoints, "net") : undefined}
                format={money}
                unit={unit}
              />
            </Kpi>
            <Kpi label="New members" Icon={UserPlus} value={String(joined)}>
              <Delta value={before ? joined - joinedBefore : null} previous={before ? joinedBefore : undefined} format={String} unit={unit} />
            </Kpi>
            <Kpi label="Visits" Icon={DoorOpen} value={String(data.active.approvedCheckIns)}>
              <Delta
                value={before ? data.active.approvedCheckIns - before.active.approvedCheckIns : null}
                previous={before?.active.approvedCheckIns}
                format={(n) => String(n)}
                unit={unit}
              />
            </Kpi>
            <Kpi label="Class fill rate" Icon={Gauge} value={classes.rate === null ? "—" : `${Math.round(classes.rate * 100)}%`}>
              {classes.rate === null ? (
                <span className="kpi__delta">No classes in this period</span>
              ) : classesBefore && classesBefore.rate === null ? (
                <span className="kpi__delta">No classes {inUnit}</span>
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
            <article className={`panel analytics-revenue${hasRevenue ? "" : " is-wide"}`}>
              <div className="analytics-panel-head">
                <h3>Revenue by {unitWord}</h3>
                {hasRevenue ? <Legend series={[["is-net", "Net"]]} earlier={before ? earlierPhrase : null} /> : null}
                <MoreLink to="/admin/payments">Open Payments</MoreLink>
              </div>
              <dl className="analytics-totals">
                <div><dt>Net receipts</dt><dd>{dollars(String(sum(points, "net")))}</dd></div>
                <div><dt>Gross</dt><dd>{dollars(String(sum(points, "gross")))}</dd></div>
                <div><dt>Refunded</dt><dd>{dollars(String(sum(points, "refunds")))}</dd></div>
              </dl>
              {hasRevenue ? (
                <PeriodBars
                  name="Revenue chart"
                  bars={revenueBars(points, period, data.from, data.to, earlier(netByDay, 100))}
                  format={money}
                />
              ) : (
                <p className="analytics-empty">No paid receipts in this period.</p>
              )}
              <details className="analytics-table">
                <summary>Show as table</summary>
                <TableScroll label="Revenue by period">
                  <table className="data-table">
                    <caption>Revenue by period (period starting date)</caption>
                    <thead>
                      <tr>
                        <th scope="col">Period</th>
                        <th scope="col" className="table-number">Receipts</th>
                        <th scope="col" className="table-number">Gross</th>
                        <th scope="col" className="table-number">Refunds</th>
                        <th scope="col" className="table-number">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {points.map((point) => (
                        <tr key={point.period}>
                          <th scope="row">{point.period}</th>
                          <td className="table-number">{point.receipts}</td>
                          <td className="table-number">{dollars(String(point.gross))}</td>
                          <td className="table-number">{dollars(String(point.refunds))}</td>
                          <td className="table-number">{dollars(String(point.net))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </details>
            </article>
            {hasRevenue ? (
              <article className="panel analytics-side-card">
                <div className="analytics-panel-head">
                  <h3>Revenue by source</h3>
                  <span className="analytics-muted">net</span>
                </div>
                <SourceList rows={data.revenue} />
              </article>
            ) : null}
          </div>

          <div className="analytics-layout">
            <article className="panel analytics-members is-wide">
              <div className="analytics-panel-head">
                <h3>Members by {unitWord}</h3>
                {joined + cancelled ? <Legend series={[["is-joined", "Joined"], ["is-cancelled", "Cancelled"]]} /> : null}
                <MoreLink to="/admin/members">Open Members</MoreLink>
              </div>
              <dl className="analytics-totals">
                <div><dt>Joined</dt><dd>{joined}</dd></div>
                <div><dt>Cancelled</dt><dd>{cancelled}</dd></div>
                <div><dt>Ended without renewing</dt><dd>{ended}</dd></div>
              </dl>
              {joined + cancelled ? (
                <PeriodBars
                  name="Members chart"
                  whole
                  grouped
                  short
                  format={(n) => String(Math.round(n))}
                  bars={members.map((row) => {
                    const partial = coverage(row.period, period, data.from, data.to);
                    const name = periodName(row.period, period);
                    return {
                      key: row.period,
                      tick: periodLabel(row.period, period),
                      segments: [
                        { value: row.newMembers, className: "is-joined" },
                        { value: row.cancelledMembers, className: "is-cancelled" },
                      ],
                      partial,
                      label: `${name}${partial ? ` (partial: ${partial})` : ""}: ${row.newMembers} joined, ${row.cancelledMembers} cancelled`,
                      detail: (
                        <span className="period-readout__line">
                          <span className="period-readout__name">{name}</span>
                          <span><i className="is-joined" />{row.newMembers} joined</span>
                          <span><i className="is-cancelled" />{row.cancelledMembers} cancelled</span>
                          {row.expiringMembers ? <span>{row.expiringMembers} ended without renewing</span> : null}
                        </span>
                      ),
                    };
                  })}
                />
              ) : (
                <p className="analytics-empty">Nobody joined or cancelled in this period.</p>
              )}
            </article>
          </div>

          <div className="analytics-layout">
            <article className={`panel analytics-visits${peak ? "" : " is-wide"}`}>
              <div className="analytics-panel-head">
                <h3>Visits by {unitWord}</h3>
                {peak ? <Legend series={[["is-visits", "Visits"]]} earlier={before ? earlierPhrase : null} /> : null}
              </div>
              <dl className="analytics-totals">
                <div><dt>Visits</dt><dd>{data.active.approvedCheckIns}</dd></div>
                <div><dt>People</dt><dd>{data.active.activeUsers}</dd></div>
                {peak ? <div><dt>Busiest day</dt><dd>{dayLabel(peak.day)} · {peak.visits}</dd></div> : null}
              </dl>
              {peak ? (
                <PeriodBars
                  name="Visits chart"
                  whole
                  format={(n) => String(Math.round(n))}
                  bars={visitPoints(data.from, data.to, period, visits).map((point) => {
                    const partial = coverage(point.period, period, data.from, data.to);
                    const name = periodName(point.period, period);
                    const then = visitsEarlier?.value(point.period);
                    return {
                      key: point.period,
                      tick: periodLabel(point.period, period),
                      segments: [{ value: point.visits, className: "is-visits" }],
                      partial,
                      earlier: then,
                      label: `${name}${partial ? ` (partial: ${partial})` : ""}: ${count(point.visits, "visit")}${then === undefined ? "" : `; ${earlierPhrase}: ${then}`}`,
                      detail: (
                        <span className="period-readout__line">
                          <span className="period-readout__name">{name}</span>
                          <span><i className="is-visits" />{count(point.visits, "visit")}</span>
                          {then === undefined ? null : <span><i className="is-earlier" />{capitalize(earlierPhrase)}: {then}</span>}
                        </span>
                      ),
                    };
                  })}
                />
              ) : (
                <p className="analytics-empty">No visits in this period.</p>
              )}
              <details className="analytics-table">
                <summary>Show daily visit counts</summary>
                <TableScroll label="Visits by day">
                  <table className="data-table">
                    <caption>Visits per day</caption>
                    <thead><tr><th scope="col">Date</th><th scope="col" className="table-number">Visits</th></tr></thead>
                    <tbody>
                      {visits.map((v) => <tr key={v.day}><th scope="row">{v.day}</th><td className="table-number">{v.visits}</td></tr>)}
                    </tbody>
                  </table>
                </TableScroll>
              </details>
            </article>
            {peak ? (
              <article className="panel analytics-side-card">
                <div className="analytics-panel-head">
                  <h3>Visits by weekday</h3>
                  <span className="analytics-muted">average a day</span>
                </div>
                <WeekdayList days={visits} from={data.from} to={data.to} />
              </article>
            ) : null}
          </div>

          {data.classes.length ? <ClassList items={data.classes} stats={classes} /> : null}

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
