import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/useApi";
import type { Audit, Page } from "../lib/staffContracts";
import { AuditList, LoadState, Pager } from "../components/Management";
import { StaffUsers } from "./StaffUsers";
import { StaffPlans } from "./StaffPlans";
import { StaffPayments } from "./StaffPayments";
import { StaffPolicies } from "./StaffPolicies";
import { AdminAnalyticsPreviewPage } from "./AdminAnalyticsPreviewPage";

const tabs = [
  ["members", "Members"],
  ["plans", "Plans"],
  ["payments", "Payment history"],
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
      ) : tab === "payments" ? (
        <StaffPayments />
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
    [userId, setUserId] = useState("");
  const records = useApi<Page<Audit>>(
    `/admin/audit?offset=${offset}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`,
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
          setOffset(0);
        }}
      >
        <label>
          Filter by member ID <input name="userId" type="number" min="1" />
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
