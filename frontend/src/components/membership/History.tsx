import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Entitlement, Page, Payment } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { dollars, shortDate, statusLabel, statusTone } from "../../lib/display";
import { LoadState } from "../Management";
import { StatusPill } from "./StatusPill";

const PAGE_SIZE = 50;

export function History({
  memberships,
  passes,
}: {
  memberships: Entitlement[];
  passes: Entitlement[];
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"records" | "payments">("records");
  return (
    <section className="panel membership-history">
      <h2 className="membership-history__heading">
        <button
          className="membership-history__toggle"
          aria-expanded={open}
          aria-controls="membership-history-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span>
            History
            <small>Past memberships, day passes, and payments</small>
          </span>
          <ChevronDown aria-hidden="true" />
        </button>
      </h2>
      {open ? (
        <div id="membership-history-body">
          <div className="membership-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "records"}
              onClick={() => setTab("records")}
            >
              Memberships &amp; passes
            </button>
            <button
              role="tab"
              aria-selected={tab === "payments"}
              onClick={() => setTab("payments")}
            >
              Payments
            </button>
          </div>
          <div role="tabpanel">
            {tab === "records" ? (
              <Records memberships={memberships} passes={passes} />
            ) : (
              <Payments />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Records({
  memberships,
  passes,
}: {
  memberships: Entitlement[];
  passes: Entitlement[];
}) {
  const rows = [
    ...memberships.map((m) => ({
      key: `m-${m.id}`,
      sort: m.startsAt ?? "",
      name: m.plan?.name ?? "Membership",
      when:
        m.startsAt && m.endsAt
          ? `${shortDate(m.startsAt, true)} – ${shortDate(m.endsAt, true)}`
          : "",
      status: m.effectiveStatus,
    })),
    ...passes.map((p) => ({
      key: `p-${p.id}`,
      sort: p.validDate ?? "",
      name: p.plan?.name ?? "Day pass",
      when: p.validDate ? shortDate(p.validDate, true) : "",
      status: p.effectiveStatus,
    })),
  ].sort((a, b) => b.sort.localeCompare(a.sort));
  if (!rows.length)
    return <p className="membership-muted">You haven't had a membership or day pass yet.</p>;
  return (
    <table className="membership-table">
      <thead>
        <tr>
          <th>Plan</th>
          <th>Dates</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.name}</td>
            <td>{r.when}</td>
            <td>
              <StatusPill tone={statusTone(r.status)}>{statusLabel(r.status)}</StatusPill>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Payments() {
  const [offset, setOffset] = useState(0);
  const payments = useApi<Page<Payment>>(`/me/payments?offset=${offset}`);
  const page = payments.data;
  return (
    <>
      <LoadState {...payments} />
      {page && !page.items.length ? (
        <p className="membership-muted">No payments yet.</p>
      ) : null}
      {page?.items.length ? (
        <table className="membership-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>For</th>
              <th>Status</th>
              <th className="membership-table__amount">Amount</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((p) => (
              <tr key={p.id}>
                <td>{shortDate(p.recordedAt)}</td>
                <td>
                  {p.planName}
                  {p.method === "manual" ? (
                    <small className="membership-muted"> · Paid at front desk</small>
                  ) : null}
                </td>
                <td>
                  <StatusPill tone={statusTone(p.status)}>
                    {p.status === "pending" ? "Pending" : statusLabel(p.status)}
                  </StatusPill>
                </td>
                <td className="membership-table__amount">{dollars(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {page && (offset > 0 || page.nextOffset !== null) ? (
        <div className="membership-pager">
          <button
            className="button button--quiet"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            className="button button--quiet"
            disabled={page.nextOffset === null}
            onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}
