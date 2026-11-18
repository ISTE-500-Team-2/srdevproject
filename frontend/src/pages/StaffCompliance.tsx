// Staff compliance review builds report filters and readable requirement cards from the server's
// readiness data.

import { Check, ChevronRight, Download, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiText, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { onArrowKeys } from "../lib/rovingFocus";
import type { ComplianceBreakdown, ComplianceIssue, ComplianceReport, Plan } from "../lib/staffContracts";
import { KeptResults, useResultsPaging } from "../components/KeptResults";
import { LoadState, Pager } from "../components/Management";
import { MemberRecord } from "../components/staff/record/MemberRecord";
import { shortDate } from "../lib/display";
import "./certwaiver.css";

type View = "attention" | "expiring" | "everyone";

interface ComplianceFilters {
  view: View;
  userStatus: string;
  offset: number;
}

function reportPath(filters: ComplianceFilters, format?: "csv") {
  const params = new URLSearchParams({
    userStatus: filters.userStatus,
    offset: String(filters.offset),
  });
  if (filters.view === "attention") params.set("attention", "true");
  if (filters.view === "expiring") params.set("expiresWithinDays", "30");
  if (format) params.set("format", format);
  return `/admin/compliance?${params}`;
}

/** "Not signed", "Expired Oct 2", "Revoked" or "Expires Nov 8", with the item's name. */
function IssueTag({ issue }: { issue: ComplianceIssue }) {
  const date = issue.expiresAt ? shortDate(issue.expiresAt) : "";
  const what =
    issue.state === "missing"
      ? issue.kind === "waiver"
        ? "Not signed"
        : "Not trained"
      : issue.state === "expired"
        ? `Expired${date ? " " + date : ""}`
        : issue.state === "revoked"
          ? "Revoked"
          : `Expires${date ? " " + date : " soon"}`;
  return (
    <span className={`cw-tag cw-tag--${issue.state === "expiring" ? "amber" : "red"}`}>
      {what} · {issue.name}
    </span>
  );
}

function RequirementCard({ item, kind }: { item: ComplianceBreakdown; kind: string }) {
  const ratio = item.total ? item.compliant / item.total : 1;
  const missing = item.total - item.compliant;
  return (
    <article className="cw-req">
      <div className="cw-req__top">
        <b>{item.name}</b>
        <span className="cw-tag cw-tag--grey">{kind}</span>
      </div>
      <div className={`cw-bar${!item.total ? " cw-bar--empty" : ratio < 0.5 ? " cw-bar--low" : ""}`} aria-hidden="true">
        <i style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <small>
        {!item.total ? (kind === "Waiver" ? "Nobody needs this yet" : "No holders in this view") : `${item.compliant} of ${item.total} current`}
        {missing ? ` · ${missing} ${kind === "Waiver" ? "haven't signed" : "not current"}` : ""}
        {item.expiring ? ` · ${item.expiring} expiring` : ""}
      </small>
    </article>
  );
}

export function StaffCompliance() {
  const [filters, setFilters] = useState<ComplianceFilters>({ view: "attention", userStatus: "active", offset: 0 });
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<{ id: number; name: string } | null>(null);
  const [exportError, setExportError] = useState("");
  const report = useApi<ComplianceReport>(reportPath(filters), { retainOnReload: true, retainOnChange: true });
  const { results, turn, busy } = useResultsPaging(report);
  const everyone = useRef<HTMLButtonElement>(null);
  const plans = useApi<Plan[]>("/admin/plans");
  const config = useApi<{ timeZone: string }>("/config", { reuse: true });
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim().toLowerCase()), 200);
    return () => window.clearTimeout(timer);
  }, [input]);
  const set = (change: Partial<ComplianceFilters>) => setFilters((f) => ({ ...f, ...change, offset: 0 }));
  const downloadCsv = async () => {
    setExportError("");
    try {
      const csv = await apiText(reportPath({ ...filters, offset: 0 }, "csv"));
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "compliance-report.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Some browsers start the download after click() returns; revoking at once can cancel it.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(errorMessage(error));
    }
  };
  const data = report.data;
  // Search narrows the page already loaded; the server pages the full list.
  const rows = (data?.users.items ?? []).filter(
    (u) => !search || `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(search),
  );
  const allSet = data && filters.view === "attention" ? data.summary.userCount - data.summary.attentionUsers : 0;

  return (
    <section className="cw-section">
      <div className="cw-row">
        <p className="cw-muted">Who is current on required waivers and certifications.</p>
        <button className="button button--quiet cw-small" type="button" onClick={() => void downloadCsv()}>
          <Download aria-hidden="true" /> Export CSV
        </button>
      </div>
      {exportError ? (
        <p className="form-error" role="alert">
          {exportError}
        </p>
      ) : null}
      <LoadState {...report} loading={report.loading && !report.data} />
      {data ? (
        <>
          <KeptResults read={report}>
            <div className="cw-reqs" aria-label="Requirements">
              {data.waiverBreakdown.map((w) => (
                <RequirementCard key={`w${w.id}`} item={w} kind="Waiver" />
              ))}
              {data.certificationBreakdown.map((c) => (
                <RequirementCard key={`c${c.id}`} item={c} kind="Certification" />
              ))}
              {!data.waiverBreakdown.length && !data.certificationBreakdown.length ? (
                <p className="cw-muted">No required waivers or certifications are set up yet.</p>
              ) : null}
            </div>
          </KeptResults>

          <div className="cw-toolbar">
            <div className="cw-chips" role="radiogroup" aria-label="Show" onKeyDown={onArrowKeys}>
              {(
                [
                  // Not the window's count: the chip reads the same on "Expiring in 30 days".
                  ["attention", `Needs attention · ${data.summary.allAttentionUsers}`],
                  ["expiring", "Expiring in 30 days"],
                  ["everyone", "Everyone"],
                ] as const
              ).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  role="radio"
                  ref={view === "everyone" ? everyone : undefined}
                  aria-checked={filters.view === view}
                  tabIndex={filters.view === view ? 0 : -1}
                  className="cw-chip"
                  onClick={() => set({ view })}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              className="cw-select"
              aria-label="Account status"
              value={filters.userStatus}
              onChange={(e) => set({ userStatus: e.target.value })}
            >
              <option value="active">Active accounts</option>
              <option value="inactive">Inactive accounts</option>
              <option value="all">All accounts</option>
            </select>
            <label className="cw-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search members"
                aria-label="Search members"
              />
            </label>
          </div>

          <KeptResults read={report} ref={results}>
            <div className="cw-list">
              <div className="cw-list__head" aria-hidden="true">
                <span>Member</span>
                <span>What's missing</span>
              </div>
              {rows.map((u) => (
                <div className="cw-list__row" key={u.id}>
                  <div>
                    <b>
                      {u.firstName} {u.lastName}
                    </b>
                    <small>{u.email}</small>
                    {u.accessStatus !== "active" ? <span className="cw-tag cw-tag--grey">{u.accessStatus}</span> : null}
                  </div>
                  <div className="cw-issues">
                    {u.issues.length ? (
                      u.issues.map((issue) => <IssueTag key={issue.kind + issue.name} issue={issue} />)
                    ) : (
                      <span className="cw-tag cw-tag--green">
                        <Check aria-hidden="true" /> All current
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="button button--quiet cw-small"
                    onClick={() => setOpen({ id: u.id, name: `${u.firstName} ${u.lastName}` })}
                    aria-label={`Open record for ${u.firstName} ${u.lastName}`}
                  >
                    Open record <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ))}
              {!rows.length ? (
                <p className="cw-list__empty">
                  {search
                    ? `No members on this page match “${input}”.`
                    : filters.view === "attention"
                      ? "Everyone is current. Nothing needs attention."
                      : "No members match these filters."}
                </p>
              ) : null}
              {allSet > 0 ? (
                <button
                type="button"
                className="cw-allset"
                onClick={() => {
                  // The list waits out of reach while the view changes: hand focus to the chip it picks.
                  everyone.current?.focus();
                  set({ view: "everyone" });
                }}
              >
                  <Check aria-hidden="true" /> {allSet} {allSet === 1 ? "member is" : "members are"} all set · show everyone
                </button>
              ) : null}
            </div>
          </KeptResults>
          <Pager
            offset={filters.offset}
            nextOffset={data.users.nextOffset}
            busy={busy}
            onChange={(offset) => turn(() => setFilters((current) => ({ ...current, offset })))}
          />
        </>
      ) : null}
      {open ? (
        <MemberRecord
          key={open.id}
          id={open.id}
          name={open.name}
          plans={plans.data ?? []}
          timeZone={config.data?.timeZone ?? "America/New_York"}
          onChanged={report.reload}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}
