import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { timeOnly } from "../../../lib/display";
import type { Audit } from "../../../lib/staffContracts";
import { activity, byDay, type ActivityRow } from "./recordModel";
import { Row } from "./recordParts";

export type ActivityFilter = "all" | ActivityRow["type"];

/** The member's recent visits, card taps and changes, by day, filtered to one kind or all. */
export function RecordActivity({
  personId,
  audit,
  filter,
  setFilter,
}: {
  personId: number;
  audit: Audit[];
  filter: ActivityFilter;
  setFilter: (f: ActivityFilter) => void;
}) {
  const rows = activity(audit);
  const shown = rows.filter((r) => filter === "all" || r.type === filter).slice(0, 15);
  return (
    <section className="today-panel" aria-labelledby={`mr-act-title-${personId}`}>
      <div className="today-panel-head">
        <h2 id={`mr-act-title-${personId}`}>Activity</h2>
        <div className="segmented" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["visit", "Visits"],
              ["tap", "Card taps"],
              ["change", "Changes"],
            ] as const
          ).map(([f, label]) => (
            <button key={f} type="button" className={filter === f ? "is-selected" : undefined} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        byDay(shown).map((g) => (
          <div key={g.day} role="group" aria-label={g.day}>
            <p className="mr-day">{g.day}</p>
            {g.rows.map((r) => (
              <Row key={r.id} icon={r.icon} tone={r.tone} title={r.title} detail={r.detail} end={<time dateTime={r.at}>{timeOnly(r.at)}</time>} />
            ))}
          </div>
        ))
      ) : (
        <p className="today-empty">{rows.length ? "Nothing of this kind recently." : "Nothing recorded yet."}</p>
      )}
      <div className="today-panel-foot">
        <Link className="today-link" to="/admin/change-log">
          Open the change log <ChevronRight aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
