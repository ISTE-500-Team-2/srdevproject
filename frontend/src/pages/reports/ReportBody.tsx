import { BellRing, CircleDollarSign, DoorOpen, Info, UserPlus } from "lucide-react";
import { Delta, Kpi } from "../../components/Kpi";
import { zoneName } from "../../lib/analytics";
import { timeOnly } from "../../lib/display";
import type { Report } from "../../lib/reportContracts";
import { Classes } from "./Classes";
import { ComplianceSummary } from "./ComplianceSummary";
import { Equipment } from "./Equipment";
import { cents, count, money, percent, plural, points, rangeName } from "./format";
import { JumpNav } from "./JumpNav";
import { LiveReaders } from "./LiveReaders";
import { Members } from "./Members";
import { MoreLink, Panel } from "./parts";
import { Reminders } from "./Reminders";
import { Revenue } from "./Revenue";
import { Rooms } from "./Rooms";
import { totals } from "./totals";

export function ReportBody({ report: d, before, unit, stale }: { report: Report; before?: Report; unit: string; stale: boolean }) {
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
