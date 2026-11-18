// Staff reports: the exact numbers behind Analytics for a chosen range, with what needs checking
// and CSV/PDF exports. Built on the Analytics page's header, cards and panels.

import {
  ArrowRight,
  BellRing,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  DoorOpen,
  Download,
  Info,
  Nfc,
  UserPlus,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { InfoTip } from "../components/InfoTip";
import { Delta, Kpi } from "../components/Kpi";
import { KeptResults } from "../components/KeptResults";
import { LoadState } from "../components/Management";
import { PeriodSwitch } from "../components/PeriodSwitch";
import { TableScroll } from "../components/TableScroll";
import { api, errorMessage } from "../lib/api";
import {
  comparison,
  presetRange,
  previousRange,
  revenuePoints,
  zoneName,
  type Preset,
  type Range,
  type RevenuePeriod,
} from "../lib/analytics";
import { dollars, statusLabel, timeOnly, zonedDay } from "../lib/display";
import { useFacilityZone } from "../lib/facilityZone";
import type { Report } from "../lib/reportContracts";
import { jumpToSection } from "../lib/sectionJump";
import { useApi } from "../lib/useApi";
import "../assets/css/analyticsDashboard.css";
import "./reports.css";


const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const cents = (value: number) => Math.round(value * 100) / 100;
const money = (value: number) => dollars(String(cents(value)));
/** 1,234 rather than 1234. */
const count = (value: number) => value.toLocaleString("en-US");
const points = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom dates" },
];
const PERIODS: RevenuePeriod[] = ["daily", "weekly", "monthly"];

/** Throws with a message staff can act on when the range can't be reported. */
const checkRange = (range: Range) => revenuePoints(range.from, range.to, range.period, []);

/** The report lives in the URL, so a bookmark or a shared link opens the same report. */
function readParams(params: URLSearchParams, today: string): { preset: Preset; range: Range } {
  const asked = params.get("range") as Preset | null;
  const preset = PRESETS.some((p) => p.value === asked) ? (asked as Preset) : "month";
  const group = params.get("group") as RevenuePeriod | null;
  const period = group && PERIODS.includes(group) ? group : "weekly";
  if (preset === "custom") {
    const range = { from: params.get("from") ?? today, to: params.get("to") ?? today, period };
    try {
      checkRange(range);
      return { preset, range };
    } catch {
      // A hand-edited link with bad dates falls back to this month.
    }
  }
  return { preset: preset === "custom" ? "month" : preset, range: { ...presetRange(preset === "custom" ? "month" : preset, today), period } };
}

const day = (value: string, options: Intl.DateTimeFormatOptions) =>
  new Date(value.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

/** A period's starting date, named the way staff say it. */
function periodName(start: string, period: RevenuePeriod) {
  if (period === "monthly") return day(start, { month: "long", year: "numeric" });
  if (period === "weekly") return `Week of ${day(start, { month: "short", day: "numeric" })}`;
  return day(start, { weekday: "short", month: "short", day: "numeric" });
}

/** A week or month the date range only partly covers, such as the week a month starts in. */
function isPartial(start: string, period: RevenuePeriod, from: string, to: string) {
  if (period === "daily") return false;
  const first = new Date(start.slice(0, 10) + "T12:00:00Z");
  const end =
    period === "weekly"
      ? new Date(first.getTime() + 6 * 864e5)
      : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
  return start.slice(0, 10) < from || end.toISOString().slice(0, 10) > to;
}

function PeriodName({ start, report: d }: { start: string; report: Report }) {
  return (
    <>
      {periodName(start, d.period)}
      {isPartial(start, d.period, d.from, d.to) ? (
        <small className="reports-partial" title="Part of this period falls outside the dates you picked">
          {d.period === "weekly" ? "Partial week" : "Partial month"}
        </small>
      ) : null}
    </>
  );
}

function rangeName(from: string, to: string) {
  if (from === to) return day(from, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${day(from, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })} – ${day(to, { month: "short", day: "numeric", year: "numeric" })}`;
}

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);
/** Hours to one decimal everywhere on the page. */
const hours = (value: number) => (value ? value.toFixed(1) : "0");

/** Records that need a decision come first, each named so staff know what to fix. */
export function ComplianceSummary({ compliance: c }: { compliance: Report["compliance"] }) {
  const warnings: string[] = [];
  if (c.restrictedAccounts) warnings.push(`${plural(c.restrictedAccounts, "account is", "accounts are")} restricted.`);
  if (c.expiredTraining)
    warnings.push(`${plural(c.expiredTraining, "expired training record is", "expired training records are")} still marked active.`);
  if (c.trainingWithoutExpiry)
    warnings.push(
      `${plural(c.trainingWithoutExpiry, "active training record never expires", "active training records never expire")}. Add an expiry date to the certification.`,
    );
  if (c.signaturesWithoutCopy)
    warnings.push(`${plural(c.signaturesWithoutCopy, "signed waiver is missing its saved copy", "signed waivers are missing their saved copy")}.`);
  if (c.machinesWithoutTraining.length)
    warnings.push(
      `${plural(c.machinesWithoutTraining.length, "bookable machine has", "bookable machines have")} no training requirement: ${c.machinesWithoutTraining.join(", ")}.`,
    );
  const fine = [
    plural(c.activeMemberships, "active membership", "active memberships"),
    plural(c.activeAccounts, "active account", "active accounts"),
    c.restrictedAccounts ? "" : "no restricted accounts",
    c.expiredTraining ? "" : "no expired training",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      {warnings.length ? (
        <ul className="reports-checks">
          {warnings.map((text) => (
            <li key={text}>
              <CircleAlert aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="reports-allclear">
          <CircleCheck aria-hidden="true" />
          All clear.
        </p>
      )}
      <p className="reports-note">{fine}</p>
    </>
  );
}

function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="analytics-link" to={to}>
      {children}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

function Panel({
  id,
  title,
  info,
  aside,
  children,
}: {
  id: string;
  title: ReactNode;
  /** A short explanation behind a circled "i" beside the title. */
  info?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel reports-panel" id={id} aria-labelledby={`${id}-title`}>
      <div className="analytics-panel-head">
        <span className="reports-panel-title">
          {/* Focusable so the section bar can move keyboard focus here (jumpToSection). */}
          <h2 id={`${id}-title`} tabIndex={-1}>
            {title}
          </h2>
          {info && <InfoTip label="What this card counts">{info}</InfoTip>}
        </span>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A small horizontal fill for a 0–100 share. */
function Fill({ value }: { value: number }) {
  return (
    <span className="analytics-fill reports-fill" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/** Long tables show their first rows; the rest are one click away. */
function useLimit<T>(rows: T[], limit: number, noun: string) {
  const [all, setAll] = useState(false);
  const toggle =
    rows.length > limit ? (
      <button type="button" className="analytics-more" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${rows.length} ${noun}`}
      </button>
    ) : null;
  return { shown: all ? rows : rows.slice(0, limit), toggle };
}

const SECTIONS = [
  ["reports-revenue", "Revenue"],
  ["reports-records", "Records"],
  ["reports-members", "Members"],
  ["reports-reminders", "Reminder emails"],
  ["reports-equipment", "Equipment"],
  ["reports-classes", "Classes"],
  ["reports-rooms", "Rooms"],
] as const;

function Heading({ children }: { children?: ReactNode }) {
  return (
    <header className="analytics-head">
      <div>
        <p className="admin-page-eyebrow">Records</p>
        <h1 className="admin-title">Reports</h1>
      </div>
      {children}
    </header>
  );
}

export function ReportsPage() {
  // The default dates are today in the facility's zone, so the report waits for it.
  const zone = useFacilityZone();
  if (!zone)
    return (
      <section className="analytics-dashboard reports management-page">
        <Heading />
        <LoadState loading error="" reload={() => undefined} />
      </section>
    );
  return <ReportsView today={zonedDay(zone)} />;
}

function ReportsView({ today }: { today: string }) {
  const [params, setParams] = useSearchParams();
  const { preset, range } = readParams(params, today);
  // The date boxes may hold a half-typed range; only a valid one reaches the URL.
  const [draft, setDraft] = useState(range);
  const [validation, setValidation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "csv" | "pdf">("");
  const query = new URLSearchParams(range).toString();
  // Back and forward change the URL, not the boxes: follow them.
  useEffect(() => setDraft(range), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new range keeps the last report on screen, faded, until the new one lands.
  const report = useApi<Report>("/admin/reports?" + query, { retainOnReload: true, retainOnChange: true, refreshInterval: 30000 });
  const previous = useApi<Report>("/admin/reports?" + new URLSearchParams(previousRange(range, preset)), {
    retainOnReload: true,
  });

  const apply = (next: Range, nextPreset: Preset = preset) => {
    setDraft(next);
    try {
      checkRange(next);
    } catch (error) {
      setValidation((error as Error).message);
      return;
    }
    setValidation("");
    const search = new URLSearchParams(params);
    search.set("range", nextPreset);
    search.set("group", next.period);
    if (nextPreset === "custom") {
      search.set("from", next.from);
      search.set("to", next.to);
    } else {
      search.delete("from");
      search.delete("to");
    }
    setParams(search, { replace: true });
  };

  async function download(format: "csv" | "pdf") {
    setBusy(format);
    setMessage("");
    try {
      const result = await api<{ filename: string; contentType: string; encoding: string; content: string }>(
        "/admin/reports/export?" + query + "&format=" + format,
      );
      const content =
        result.encoding === "base64" ? Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0)) : result.content;
      const url = URL.createObjectURL(new Blob([content], { type: result.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const d = report.data;
  const stale = Boolean(report.stale);
  const expected = d ? previousRange(d, preset) : null;
  const before =
    previous.data && expected && previous.data.from === expected.from && previous.data.to === expected.to
      ? previous.data
      : undefined;

  return (
    <section className="analytics-dashboard reports management-page">
      <Heading>
        <div className="analytics-controls">
          <label className="analytics-range">
            <CalendarDays aria-hidden="true" />
            <select
              value={preset}
              aria-label="Date range"
              onChange={(e) => {
                const value = e.target.value as Preset;
                apply(value === "custom" ? { ...draft, ...range } : { ...draft, ...presetRange(value, today) }, value);
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
          <PeriodSwitch label="Group results by" value={range.period} onChange={(p) => apply({ ...draft, period: p })} />
          <div className="reports-export" role="group" aria-label="Download this report">
            {(["csv", "pdf"] as const).map((format) => (
              <button
                key={format}
                type="button"
                className="button button--quiet"
                disabled={Boolean(busy) || !d || stale}
                aria-label={`Export ${format.toUpperCase()}`}
                onClick={() => void download(format)}
              >
                <Download aria-hidden="true" />
                {busy === format ? "Preparing…" : format.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </Heading>
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
      {message ? <p role="alert" className="form-error">{message}</p> : null}

      <LoadState {...report} loading={report.loading && !d} />

      {d ? (
        <KeptResults read={report}>
          <ReportBody report={d} before={before} unit={comparison(preset, d).unit} stale={stale} />
        </KeptResults>
      ) : null}
    </section>
  );
}

function totals(r: Report) {
  const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const cohorts = Object.entries(r.notifications?.cohorts ?? {});
  const due = sum(cohorts, ([, c]) => c.eligible);
  return {
    net: cents(sum(r.revenue, (x) => Number(x.net))),
    gross: cents(sum(r.revenue, (x) => Number(x.gross))),
    refunds: cents(sum(r.revenue, (x) => Number(x.refunds))),
    receipts: sum(r.revenue, (x) => x.receipts),
    joined: sum(r.memberships ?? [], (x) => x.newMembers),
    ended: sum(r.memberships ?? [], (x) => x.expiringMembers),
    cancelled: sum(r.memberships ?? [], (x) => x.cancelledMembers),
    cohorts,
    due,
    onTime: due ? (100 * sum(cohorts, ([, c]) => c.delivery_on_time)) / due : null,
    deliveredOnTime: sum(cohorts, ([, c]) => c.delivery_on_time),
  };
}

function ReportBody({ report: d, before, unit, stale }: { report: Report; before?: Report; unit: string; stale: boolean }) {
  const t = totals(d);
  const b = before ? totals(before) : null;
  const unitWord = d.period === "daily" ? "day" : d.period === "weekly" ? "week" : "month";
  const warnings =
    (d.compliance.restrictedAccounts ? 1 : 0) +
    (d.compliance.expiredTraining ? 1 : 0) +
    (d.compliance.trainingWithoutExpiry ? 1 : 0) +
    (d.compliance.signaturesWithoutCopy ? 1 : 0) +
    (d.compliance.machinesWithoutTraining.length ? 1 : 0);

  return (
    <div className="reports-body">
      <p className="analytics-now reports-meta">
        <span>
          <b>{rangeName(d.from, d.to)}</b>
        </span>
        <span>Grouped by {unitWord}</span>
        <span>Compared with {unit}</span>
        <span>
          Updated {timeOnly(d.generatedAt, d.timeZone)} {zoneName(d.timeZone)}
        </span>
        <span role="status" className="reports-updating">
          {stale ? "Updating…" : ""}
        </span>
      </p>

      <div className="kpis" aria-label="Totals for this period">
        <Kpi label="Net revenue" Icon={CircleDollarSign} value={money(t.net)}>
          <Delta value={b ? cents(t.net - b.net) : null} previous={b?.net} format={money} unit={unit} />
          <span className="kpi__note">
            {plural(t.receipts, "receipt", "receipts")}
            {t.refunds ? `, ${money(t.refunds)} refunded` : ""}
          </span>
        </Kpi>
        <Kpi label="Visits" Icon={DoorOpen} value={count(d.active.approvedCheckIns)}>
          <Delta
            value={before ? d.active.approvedCheckIns - before.active.approvedCheckIns : null}
            previous={before?.active.approvedCheckIns}
            format={count}
            unit={unit}
          />
          <span className="kpi__note">{plural(d.active.activeUsers, "person", "different people")}</span>
        </Kpi>
        <Kpi label="New members" Icon={UserPlus} value={count(t.joined)}>
          <Delta value={b ? t.joined - b.joined : null} previous={b?.joined} format={count} unit={unit} />
          <span className="kpi__note">
            {t.cancelled || t.ended ? `${count(t.cancelled)} cancelled, ${count(t.ended)} ended without renewing` : "No cancellations"}
          </span>
        </Kpi>
        <Kpi label="Reminders on time" Icon={BellRing} value={percent(t.onTime)}>
          {t.onTime === null ? (
            <span className="kpi__delta">None were due</span>
          ) : b && b.onTime !== null ? (
            <Delta value={Math.round(t.onTime) - Math.round(b.onTime)} format={points} unit={unit} />
          ) : (
            <span className="kpi__delta">None due {unit.startsWith("the ") ? `in ${unit}` : unit}</span>
          )}
          {t.due ? <span className="kpi__note">{count(t.deliveredOnTime)} of {count(t.due)} arrived on time</span> : null}
        </Kpi>
      </div>

      <JumpNav warnings={warnings} />

      <div className="reports-top">
        <Revenue report={d} t={t} />
        <div className="reports-side">
          <Panel
            id="reports-records"
            title={
              <>
                Records to check
                {warnings ? <span className="reports-count">{warnings}</span> : null}
              </>
            }
            aside={<MoreLink to="/admin/certifications?section=compliance">Open Compliance</MoreLink>}
          >
            <ComplianceSummary compliance={d.compliance} />
          </Panel>
          <LiveReaders report={d} />
        </div>
      </div>

      <Members report={d} t={t} unitWord={unitWord} />
      <Reminders cohorts={t.cohorts} />
      <Equipment report={d} />

      <div className="reports-pair">
        <Classes classes={d.classes} zone={d.timeZone} />
        <Rooms rooms={d.rooms} />
      </div>

      <footer className="analytics-foot">
        <details>
          <summary>
            <Info aria-hidden="true" /> How these numbers are counted
          </summary>
          {d.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </details>
        <span>Refreshes every 30 seconds</span>
      </footer>
    </div>
  );
}

/** Stays in view while scrolling and marks the section on screen. */
function JumpNav({ warnings }: { warnings: number }) {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = SECTIONS.find(([id]) => visible.get(id));
        if (first) setActive(first[0]);
      },
      // The band just under the sticky bar decides which section is "current".
      { rootMargin: "-120px 0px -60% 0px" },
    );
    for (const [id] of SECTIONS) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <nav className="reports-jump" aria-label="Report sections">
      {SECTIONS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-label={id === "reports-records" && warnings ? `${label}, ${warnings} to check` : undefined}
          aria-current={active === id ? "location" : undefined}
          onClick={() => {
            setActive(id);
            jumpToSection(id);
          }}
        >
          {label}
          {id === "reports-records" && warnings ? <em aria-hidden="true">{warnings}</em> : null}
        </button>
      ))}
    </nav>
  );
}

function Revenue({ report: d, t }: { report: Report; t: ReturnType<typeof totals> }) {
  const { shown, toggle } = useLimit(d.revenue, 10, "rows");
  return (
    <Panel id="reports-revenue" title="Revenue" aside={<MoreLink to="/admin/payments">Open Payments</MoreLink>}>
      <dl className="analytics-totals">
        <div><dt>Net</dt><dd>{money(t.net)}</dd></div>
        <div><dt>Gross</dt><dd>{money(t.gross)}</dd></div>
        <div><dt>Refunded</dt><dd>{money(t.refunds)}</dd></div>
        <div><dt>Receipts</dt><dd>{count(t.receipts)}</dd></div>
      </dl>
      {d.revenue.length ? (
        <>
          <TableScroll label="Revenue rows">
            <table className="data-table reports-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Category</th>
                  <th scope="col">Method</th>
                  <th scope="col" className="table-number">Receipts</th>
                  <th scope="col" className="table-number">Gross</th>
                  <th scope="col" className="table-number">Refunded</th>
                  <th scope="col" className="table-number">Net</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {/* Name a period once; its other rows sit under it. */}
                    <td className={i && shown[i - 1].period === r.period ? "reports-nowrap reports-repeat" : "reports-nowrap"}>
                      <PeriodName start={r.period} report={d} />
                    </td>
                    <td>{r.category}</td>
                    <td>{statusLabel(r.method)}</td>
                    <td className="table-number">{r.receipts}</td>
                    <td className="table-number">{dollars(r.gross)}</td>
                    <td className="table-number">{Number(r.refunds) ? dollars(r.refunds) : <span className="reports-muted">—</span>}</td>
                    <td className="table-number">{dollars(r.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>Total</th>
                  <td className="table-number">{count(t.receipts)}</td>
                  <td className="table-number">{money(t.gross)}</td>
                  <td className="table-number">{t.refunds ? money(t.refunds) : <span className="reports-muted">—</span>}</td>
                  <td className="table-number">{money(t.net)}</td>
                </tr>
              </tfoot>
            </table>
          </TableScroll>
          {toggle}
        </>
      ) : (
        <p className="reports-empty">No payments in this period.</p>
      )}
    </Panel>
  );
}

/** Who holds a reader right now. Ignores the date range. */
function LiveReaders({ report: d }: { report: Report }) {
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

function Members({ report: d, t, unitWord }: { report: Report; t: ReturnType<typeof totals>; unitWord: string }) {
  const rows = d.memberships ?? [];
  const { shown, toggle } = useLimit(rows, 10, `${unitWord}s`);
  return (
    <Panel id="reports-members" title={`Members by ${unitWord}`} aside={<MoreLink to="/admin/members">Open Members</MoreLink>}>
      <dl className="analytics-totals">
        <div><dt>Joined</dt><dd>{t.joined}</dd></div>
        <div><dt>Cancelled</dt><dd>{t.cancelled}</dd></div>
        <div><dt>Ended without renewing</dt><dd>{t.ended}</dd></div>
      </dl>
      <TableScroll label="Members by period">
        <table className="data-table reports-table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="table-number">New members</th>
              <th scope="col" className="table-number">Active members</th>
              <th scope="col" className="table-number">Ended without renewing</th>
              <th scope="col" className="table-number">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.period}>
                <td className="reports-nowrap">
                  <PeriodName start={row.period} report={d} />
                </td>
                <td className="table-number">{row.newMembers || <span className="reports-muted">0</span>}</td>
                <td className="table-number">{row.activeMembers}</td>
                <td className="table-number">{row.expiringMembers || <span className="reports-muted">0</span>}</td>
                <td className="table-number">{row.cancelledMembers || <span className="reports-muted">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {toggle}
      <p className="reports-note">Renewals don't count as new members.</p>
    </Panel>
  );
}

const cohortNames: Record<string, string> = {
  expirationCompliance: "Waiver & training expiry",
  membershipExpiration: "Membership expiry",
  other: "Account, billing & other",
};

function Reminders({ cohorts }: { cohorts: [string, Report["notifications"]["cohorts"][string]][] }) {
  return (
    <Panel id="reports-reminders" title="Reminder emails">
      <p className="reports-note reports-note--top">
        Reminders due in this period. <b>Sent</b>: left our system on time. <b>Delivered</b>: reached the member's inbox on
        time.
      </p>
      <TableScroll label="Reminder emails">
        <table className="data-table reports-table">
          <thead>
            <tr>
              <th scope="col">Reminder</th>
              <th scope="col" className="table-number">Due</th>
              <th scope="col">Sent on time</th>
              <th scope="col">Delivered on time</th>
              <th scope="col" className="table-number">Delivered (any time)</th>
              <th scope="col">Problems</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(([key, row]) => {
              const problems = (
                [
                  [row.failed, "failed to send", "failed to send"],
                  [row.delivery_failed, "bounced", "bounced"],
                  [row.uncertain, "uncertain", "uncertain"],
                  [row.pending, "pending", "pending"],
                ] as const
              ).filter(([count]) => count > 0);
              return (
                <tr key={key}>
                  <th scope="row">{cohortNames[key] ?? statusLabel(key)}</th>
                  <td className="table-number">{row.eligible}</td>
                  <td>
                    <Rate value={row.onTimePercent} count={row.on_time} due={row.eligible} />
                  </td>
                  <td>
                    <Rate value={row.deliveryOnTimePercent} count={row.delivery_on_time} due={row.eligible} />
                  </td>
                  <td className="table-number">{row.delivered}</td>
                  <td>
                    {problems.length ? (
                      <span className="reports-chips">
                        {problems.map(([count, one, many]) => (
                          <span key={one} className="status-pill status-pill--warn">
                            {count} {count === 1 ? one : many}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="reports-muted">None</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

function Rate({ value, count: n, due }: { value: number | null; count: number; due: number }) {
  if (value === null) return <span className="reports-muted">None due</span>;
  return (
    <span className="reports-rate">
      <Fill value={value} />
      <span>
        <b>{percent(value)}</b> <small>{count(n)} of {count(due)}</small>
      </span>
    </span>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourName = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;

function Equipment({ report: d }: { report: Report }) {
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

/** Weekday by hour, one hue darkening with booked hours; hovering a square names it. */
function BusiestTimes({ patterns: all }: { patterns: Report["patterns"] }) {
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

/** "Nov 3, 6:00 PM": the year is already in the range above. */
const classTime = (at: string, zone: string) =>
  new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });

function classState(item: Report["classes"][number]) {
  if (item.status === "cancelled") return "Cancelled";
  return Date.parse(item.startsAt) < Date.now() ? "Held" : "Upcoming";
}
const stateTone = { Held: "ok", Upcoming: "neutral", Cancelled: "warn" } as const;

function Classes({ classes, zone }: { classes: Report["classes"]; zone: string }) {
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

function Rooms({ rooms }: { rooms: Report["rooms"] }) {
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
