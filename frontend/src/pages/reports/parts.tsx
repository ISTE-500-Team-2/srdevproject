// Building blocks shared by the report's panels: the panel frame, links, fills and row limits.

import { ArrowRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { InfoTip } from "../../components/InfoTip";
import type { Report } from "../../lib/reportContracts";
import { isPartial, periodName } from "./format";

export function PeriodName({ start, report: d }: { start: string; report: Report }) {
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

export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="analytics-link" to={to}>
      {children}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

export function Panel({
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
export function Fill({ value }: { value: number }) {
  return (
    <span className="analytics-fill reports-fill" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/** Long tables show their first rows; the rest are one click away. */
export function useLimit<T>(rows: T[], limit: number, noun: string) {
  const [all, setAll] = useState(false);
  const toggle =
    rows.length > limit ? (
      <button type="button" className="analytics-more" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${rows.length} ${noun}`}
      </button>
    ) : null;
  return { shown: all ? rows : rows.slice(0, limit), toggle };
}

export function Heading({ children }: { children?: ReactNode }) {
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
