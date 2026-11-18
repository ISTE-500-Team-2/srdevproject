// Shows historical access and payment records separately from the member's currently effective
// entitlement.

import { TableScroll } from "../TableScroll";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Entitlement, Page, Payment } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { onArrowKeys } from "../../lib/rovingFocus";
import { dollars, shortDate, statusLabel, statusTone } from "../../lib/display";
import { LoadState } from "../Management";
import { KeptResults, useResultsPaging } from "../KeptResults";
import { StatusPill } from "./StatusPill";

const PAGE_SIZE = 50;
// Methods staff record for payments taken in person (see PaymentControls).
const DESK_METHODS = new Set(["cash", "external_card", "bank_transfer", "other"]);

export function History({
  memberships,
  passes,
}: {
  memberships: Entitlement[];
  passes: Entitlement[];
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"records" | "payments">("records");
  const ids = useId();
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
          <div className="membership-tabs" role="tablist" aria-label="History" onKeyDown={onArrowKeys}>
            <button
              id={`${ids}-records`}
              role="tab"
              aria-selected={tab === "records"}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === "records" ? 0 : -1}
              onClick={() => setTab("records")}
            >
              Memberships &amp; passes
            </button>
            <button
              id={`${ids}-payments`}
              role="tab"
              aria-selected={tab === "payments"}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === "payments" ? 0 : -1}
              onClick={() => setTab("payments")}
            >
              Payments
            </button>
          </div>
          <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab}`}>
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
    <TableScroll label="Memberships and passes history">
      <table className="membership-table">
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Dates</th>
            <th scope="col">Status</th>
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
    </TableScroll>
  );
}

function Payments() {
  const [offset, setOffset] = useState(0);
  // Another page keeps this one on screen until it lands.
  const payments = useApi<Page<Payment>>(`/me/payments?offset=${offset}`, { retainOnChange: true });
  const page = payments.data;
  const { results, turn, busy } = useResultsPaging(payments);
  const older = page?.nextOffset ?? null;
  return (
    <>
      <LoadState {...payments} />
      {page ? (
        <KeptResults read={payments} ref={results}>
          {!page.items.length ? (
            <p className="membership-muted">No payments yet.</p>
          ) : (
            <TableScroll label="Payment history">
              <table className="membership-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">For</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="membership-table__amount">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((p) => (
                    <tr key={p.id}>
                      <td>{shortDate(p.recordedAt)}</td>
                      <td>
                        {p.planName}
                        {DESK_METHODS.has(p.method) ? (
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
            </TableScroll>
          )}
        </KeptResults>
      ) : null}
      {/* While a page loads the buttons stay focusable but do nothing (see Pager). */}
      {page && (offset > 0 || older !== null || busy) ? (
        <div className="membership-pager">
          <button
            className="button button--quiet"
            disabled={!busy && offset === 0}
            aria-disabled={busy || undefined}
            onClick={() => !busy && turn(() => setOffset(Math.max(0, offset - PAGE_SIZE)))}
          >
            Previous
          </button>
          <button
            className="button button--quiet"
            disabled={!busy && older === null}
            aria-disabled={busy || undefined}
            onClick={() => !busy && older !== null && turn(() => setOffset(older))}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}
