import { AnalyticsDashboardPage } from "./AnalyticsDashboardPage";
import { AdminCertificationsPage } from "./AdminCertificationsPage";
import { useEffect, useState, type ComponentType } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/useApi";
import type { Audit, Page } from "../lib/staffContracts";
import { AuditList, LoadState, Pager } from "../components/Management";
import { StaffUsers } from "./StaffUsers";
import { StaffPlans } from "./StaffPlans";
import { StaffPayments } from "./StaffPayments";
import { StaffReservations } from "./StaffReservations";
import { ReportsPage } from "./ReportsPage";
import { AccessManagementPage } from "./AccessManagementPage";

type Tab = { key: string; label: string; component: ComponentType };
// Grouped by job so staff scan four groups instead of a wall of buttons. Keys
// are the existing ?tab= values, so bookmarked links keep working.
const groups: { label: string; tabs: Tab[] }[] = [
  {
    label: "Overview",
    tabs: [
      { key: "analytics", label: "Analytics", component: AnalyticsDashboardPage },
      { key: "reports", label: "Reports", component: ReportsPage },
    ],
  },
  {
    label: "People",
    tabs: [
      { key: "members", label: "Members", component: StaffUsers },
      {
        key: "adminCertWaiver",
        label: "Certifications & waivers",
        component: AdminCertificationsPage,
      },
    ],
  },
  {
    label: "Billing",
    tabs: [
      { key: "plans", label: "Plans", component: StaffPlans },
      { key: "payments", label: "Payments", component: StaffPayments },
    ],
  },
  {
    label: "Operations",
    tabs: [
      { key: "reservations", label: "Reservations", component: StaffReservations },
      { key: "access", label: "Reader access", component: AccessManagementPage },
      { key: "audit", label: "Change log", component: ChangeLog },
    ],
  },
];
const tabs = groups.flatMap((group) => group.tabs);
// Compliance, Policies and Training used to be separate tabs that duplicated
// Certifications & waivers; old links land on the matching section.
const legacy: Record<string, string> = {
  compliance: "compliance",
  policies: "waivers",
  training: "certifications",
};

export function AdminDashboardPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") ?? "members";
  const legacySection = legacy[requested];
  const tab = legacySection ? "adminCertWaiver" : requested;
  useEffect(() => {
    if (legacySection)
      setParams({ tab: "adminCertWaiver", section: legacySection }, { replace: true });
  }, [legacySection, setParams]);
  // Unknown tab URLs still display members without selecting a known tab.
  const TabContent = tabs.find((item) => item.key === tab)?.component ?? StaffUsers;
  return (
    <div className="management-page page-enter">
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Staff workspace</p>
          <h1>Membership & access management</h1>
        </div>
      </section>
      <nav className="staff-nav" aria-label="Staff sections">
        {groups.map((group) => (
          <div className="staff-nav__group" key={group.label}>
            <span className="staff-nav__label" aria-hidden="true">
              {group.label}
            </span>
            <div className="staff-nav__tabs">
              {group.tabs.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={tab === key ? "is-selected" : ""}
                  aria-current={tab === key ? "page" : undefined}
                  onClick={() => setParams({ tab: key })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <label className="staff-nav-select">
        <span>Section</span>
        <select
          value={tabs.some((item) => item.key === tab) ? tab : ""}
          onChange={(e) => setParams({ tab: e.target.value })}
        >
          {!tabs.some((item) => item.key === tab) && <option value="">Choose a section</option>}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.tabs.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <TabContent />
    </div>
  );
}
function ChangeLog() {
  const [offset, setOffset] = useState(0),
    [filters, setFilters] = useState({
      userId: "",
      actorId: "",
      action: "",
      from: "",
      to: "",
    });
  const query = new URLSearchParams({ offset: String(offset) });
  if (filters.userId) query.set("userId", filters.userId);
  if (filters.actorId) query.set("actorId", filters.actorId);
  if (filters.action) query.set("action", filters.action);
  if (filters.from) query.set("from", new Date(filters.from).toISOString());
  if (filters.to) query.set("to", new Date(filters.to).toISOString());
  const records = useApi<Page<Audit>>(
    `/admin/audit?${query.toString()}`,
  );
  return (
    <section>
      <h2>Staff change log</h2>
      <p>
        Search recorded changes by user, action, and time.
      </p>
      <form
        className="management-search"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setFilters({
            userId: String(form.get("userId") ?? ""),
            actorId: String(form.get("actorId") ?? ""),
            action: String(form.get("action") ?? "").trim(),
            from: String(form.get("from") ?? ""),
            to: String(form.get("to") ?? ""),
          });
          setOffset(0);
        }}
      >
        <label>
          User ID <input name="userId" type="number" min="1" />
        </label>
        <label>
          Actor ID <input name="actorId" type="number" min="1" />
        </label>
        <label>
          Action <input name="action" placeholder="user.role_changed" />
        </label>
        <label>
          From <input name="from" type="datetime-local" />
        </label>
        <label>
          To <input name="to" type="datetime-local" />
        </label>
        <button className="button button--quiet">Search changes</button>
      </form>
      <LoadState {...records} />
      {records.data ? (
        <>
          <AuditList items={records.data.items} />
          <Pager
            offset={offset}
            nextOffset={records.data.nextOffset}
            onChange={setOffset}
          />
        </>
      ) : null}
    </section>
  );
}
