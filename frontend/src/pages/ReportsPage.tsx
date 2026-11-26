// Staff reports: the exact numbers behind Analytics for a chosen range, with what needs checking
// and CSV/PDF exports. Built on the Analytics page's header, cards and panels.

import { CalendarDays, ChevronDown, Download } from "lucide-react";
import { KeptResults } from "../components/KeptResults";
import { LoadState } from "../components/Management";
import { PeriodSwitch } from "../components/PeriodSwitch";
import { comparison, presetRange, type Preset } from "../lib/analytics";
import { zonedDay } from "../lib/display";
import { useFacilityZone } from "../lib/facilityZone";
import { PRESETS } from "./reports/params";
import { Heading } from "./reports/parts";
import { ReportBody } from "./reports/ReportBody";
import { useReportRange } from "./reports/useReportRange";
import "../assets/css/analyticsDashboard.css";
import "./reports.css";

export { ComplianceSummary } from "./reports/ComplianceSummary";

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
  const { preset, range, draft, validation, message, busy, apply, download, report, d, stale, before } = useReportRange(today);

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
