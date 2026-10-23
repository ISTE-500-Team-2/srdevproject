import { Download, Filter, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { apiText, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { ComplianceBreakdown, ComplianceReport } from "../lib/staffContracts";
import { LoadState, Pager } from "../components/Management";

function percent(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function reportPath(filters: ComplianceFilters, format?: "csv") {
  const params = new URLSearchParams({
    userStatus: filters.userStatus,
    offset: String(filters.offset),
  });
  if (filters.waiverId) params.set("waiverId", filters.waiverId);
  if (filters.certificationId) params.set("certificationId", filters.certificationId);
  if (filters.expiresWithinDays !== "") params.set("expiresWithinDays", filters.expiresWithinDays);
  if (format) params.set("format", format);
  return `/admin/compliance?${params}`;
}

interface ComplianceFilters {
  waiverId: string;
  certificationId: string;
  expiresWithinDays: string;
  userStatus: string;
  offset: number;
}

export function StaffCompliance() {
  const [filters, setFilters] = useState<ComplianceFilters>({
    waiverId: "",
    certificationId: "",
    expiresWithinDays: "",
    userStatus: "active",
    offset: 0,
  });
  const [exportError, setExportError] = useState("");
  const report = useApi<ComplianceReport>(reportPath(filters));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters({
      waiverId: String(form.get("waiverId") ?? ""),
      certificationId: String(form.get("certificationId") ?? ""),
      expiresWithinDays: String(form.get("expiresWithinDays") ?? ""),
      userStatus: String(form.get("userStatus") ?? "active"),
      offset: 0,
    });
  };
  const downloadCsv = async () => {
    setExportError("");
    try {
      const csv = await apiText(reportPath({ ...filters, offset: 0 }, "csv"));
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "compliance-report.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(errorMessage(error));
    }
  };
  const summary = report.data?.summary;
  return (
    <section className="management-records">
      <div className="panel management-panel">
        <div className="compliance-heading">
          <div>
            <h2>Waiver and certification compliance</h2>
            <p>
              Rates cover matching accounts and current required waiver versions,
              with certification renewals checked against today.
            </p>
          </div>
          <button className="button button--quiet" type="button" onClick={downloadCsv}>
            <Download aria-hidden="true" /> Export CSV
          </button>
        </div>
        {exportError ? <p className="form-error">{exportError}</p> : null}
        <form className="management-search compliance-filters" onSubmit={submit}>
          <label>
            Waiver type
            <select name="waiverId" defaultValue={filters.waiverId}>
              <option value="">All required waivers</option>
              {report.data?.options.waivers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} {w.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Certification
            <select name="certificationId" defaultValue={filters.certificationId}>
              <option value="">All certifications</option>
              {report.data?.options.certifications.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Expiration window
            <select name="expiresWithinDays" defaultValue={filters.expiresWithinDays}>
              <option value="">All records</option>
              <option value="0">Expired today</option>
              <option value="30">Next 30 days</option>
              <option value="60">Next 60 days</option>
              <option value="90">Next 90 days</option>
            </select>
          </label>
          <label>
            User status
            <select name="userStatus" defaultValue={filters.userStatus}>
              <option value="active">Active accounts</option>
              <option value="inactive">Inactive accounts</option>
              <option value="all">All accounts</option>
            </select>
          </label>
          <button className="button button--quiet">
            <Filter aria-hidden="true" /> Filter
          </button>
        </form>
        <LoadState {...report} />
        {summary ? (
          <div className="compliance-metrics" aria-label="Compliance rates">
            <Metric label="Overall compliant" value={percent(summary.complianceRate)} detail={`${summary.compliantUsers} of ${summary.userCount} users`} />
            <Metric label="Waiver compliant" value={percent(summary.waiverComplianceRate)} detail={`${summary.waiverCompliantUsers} of ${summary.userCount} users`} />
            <Metric label="Certification compliant" value={percent(summary.certificationComplianceRate)} detail={`${summary.certificationCompliantUsers} of ${summary.userCount} users`} />
          </div>
        ) : null}
      </div>
      {report.data ? (
        <>
          <Breakdown title="Waiver compliance by type" items={report.data.waiverBreakdown} />
          <Breakdown title="Certification compliance" items={report.data.certificationBreakdown} />
          <div className="panel management-panel">
            <h2>Member exceptions and expirations</h2>
            <div className="compliance-table-wrap">
              <table className="compliance-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Status</th>
                    <th>Waivers</th>
                    <th>Certifications</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.users.items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.firstName} {u.lastName}</strong>
                        <small>#{u.id} {u.email}</small>
                      </td>
                      <td>
                        {u.status}<small>Access {u.accessStatus}</small>
                      </td>
                      <td>
                        <ComplianceState ok={u.waiverCompliant} />
                        <ExceptionList label="Missing or expired" values={u.missingWaivers} />
                        <ExceptionList label="Expired or expiring" values={u.expiringWaivers} />
                      </td>
                      <td>
                        <ComplianceState ok={u.certificationCompliant} />
                        <ExceptionList label="Missing or expired" values={u.missingCertifications} />
                        <ExceptionList label="Expired or expiring" values={u.expiringCertifications} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!report.data.users.items.length ? <p>No matching compliance records.</p> : null}
            </div>
            <Pager
              offset={filters.offset}
              nextOffset={report.data.users.nextOffset}
              onChange={(offset) => setFilters((current) => ({ ...current, offset }))}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Breakdown({ title, items }: { title: string; items: ComplianceBreakdown[] }) {
  return (
    <div className="panel management-panel">
      <h2>{title}</h2>
      <div className="compliance-breakdown">
        {items.map((item) => (
          <article className="management-record" key={item.id}>
            <h3>{item.name}{item.version ? ` ${item.version}` : ""}</h3>
            <p>{percent(item.total ? item.compliant / item.total : 1)} compliant</p>
            <small>{item.compliant} of {item.total} users current; {item.expiring} expired or expiring in the selected window.</small>
          </article>
        ))}
        {!items.length ? <p>No records for this filter.</p> : null}
      </div>
    </div>
  );
}

function ComplianceState({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "compliance-state is-ok" : "compliance-state is-risk"}>
      <ShieldCheck aria-hidden="true" /> {ok ? "Current" : "Needs review"}
    </span>
  );
}

function ExceptionList({ label, values }: { label: string; values: string[] }) {
  return values.length ? (
    <small>
      {label}: {values.join("; ")}
    </small>
  ) : null;
}
