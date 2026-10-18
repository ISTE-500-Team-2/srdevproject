import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/useApi";
import type { Audit, Page } from "../lib/staffContracts";
import { AuditList, LoadState, Pager } from "../components/Management";
import { StaffUsers } from "./StaffUsers";
import { StaffPlans } from "./StaffPlans";
import { StaffPayments } from "./StaffPayments";
import { StaffPolicies } from "./StaffPolicies";
import { StaffReservations } from "./StaffReservations";
import { AdminAnalyticsPreviewPage } from "./AdminAnalyticsPreviewPage";
import { StaffCompliance } from "./StaffCompliance";

const tabs = [
  ["members", "Members"],
  ["plans", "Plans"],
  ["reservations", "Reservations"],
  ["payments", "Payment history"],
  ["compliance", "Compliance"],
  ["policies", "Policies"],
  ["audit", "Change log"],
  ["preview", "Analytics preview"],
];
export function AdminDashboardPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "members";
  return (
    <div className="management-page page-enter">
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Staff workspace</p>
          <h1>Membership & access management</h1>
        </div>
      </section>
      <nav className="management-tabs" aria-label="Staff sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "is-selected" : ""}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setParams({ tab: key! })}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "plans" ? (
        <StaffPlans />
      ) : tab === "reservations" ? (
        <StaffReservations />
      ) : tab === "payments" ? (
        <StaffPayments />
      ) : tab === "compliance" ? (
        <StaffCompliance />
      ) : tab === "policies" ? (
        <StaffPolicies />
      ) : tab === "audit" ? (
        <ChangeLog />
      ) : tab === "preview" ? (
        <AdminAnalyticsPreviewPage />
      ) : (
        <StaffUsers />
      )}
    </div>
  );
}
function ChangeLog() {
  const [offset, setOffset] = useState(0),
    [filters, setFilters] = useState({
      userId: "",
      action: "",
      from: "",
      to: "",
    });
  const query = new URLSearchParams({ offset: String(offset) });
  if (filters.userId) query.set("userId", filters.userId);
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
