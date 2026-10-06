import { TrainingPage } from "./TrainingPage";
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
import { ReportsPage } from "./ReportsPage";
import { AccessManagementPage } from "./AccessManagementPage";

const tabs = [
  ["members", "Members"],
  ["plans", "Plans"],
  ["reservations", "Reservations"],
  ["payments", "Payment history"],
  ["policies", "Policies"],
  ["training", "Training"],
  ["audit", "Change log"],
  ["reports", "Reports"],
  ["access", "Reader access"],
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
      ) : tab === "policies" ? (
        <StaffPolicies />
      ) : tab === "training" ? (
        <TrainingPage />
      ) : tab === "audit" ? (
        <ChangeLog />
      ) : tab === "reports" ? (
        <ReportsPage />
      ) : tab === "access" ? (
        <AccessManagementPage />
      ) : (
        <StaffUsers />
      )}
    </div>
  );
}
function ChangeLog() {
  const [offset, setOffset] = useState(0),
    [userId, setUserId] = useState(""),
    [filters, setFilters] = useState("");
  const records = useApi<Page<Audit>>(
    `/admin/audit?offset=${offset}&${filters}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`,
  );
  return (
    <section>
      <h2>Staff change log</h2>
      <p>
        Who changed what, when, and why. Expand an entry for its before/after
        values.
      </p>
      <form
        className="management-search"
        onSubmit={(e) => {
          e.preventDefault();
          setUserId(String(new FormData(e.currentTarget).get("userId") ?? ""));
          const f = new FormData(e.currentTarget),
            q = new URLSearchParams();
          for (const field of ["actorId", "action"]) {
            const v = String(f.get(field) ?? "");
            if (v) q.set(field, v);
          }
          for (const field of ["from", "to"]) {
            const v = String(f.get(field) ?? "");
            if (v) q.set(field, new Date(v).toISOString());
          }
          setFilters(q.toString());
          setOffset(0);
        }}
      >
        <label>
          Filter by member ID <input name="userId" type="number" min="1" />
        </label>
        <label>
          Actor ID
          <input name="actorId" type="number" min={1} />
        </label>
        <label>
          Exact action
          <input name="action" placeholder="training.approved" />
        </label>
        <label>
          From
          <input name="from" type="datetime-local" />
        </label>
        <label>
          Before
          <input name="to" type="datetime-local" />
        </label>
        <button className="button button--quiet">Filter changes</button>
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
