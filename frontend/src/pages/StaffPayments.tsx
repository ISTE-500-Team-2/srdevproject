import { useEffect, useRef, useState } from "react";
import { MemberSelect } from "../components/MemberSelect";
import { LoadState, Pager } from "../components/Management";
import { paymentStatusName } from "../components/staff/PaymentControls";
import { PaymentTable } from "../components/staff/PaymentTable";
import { addCalendarDays } from "../lib/calendarDate";
import { dollars, zonedDay } from "../lib/display";
import { useFacilityZone, zonedDayStart } from "../lib/facilityZone";
import type { PaymentPage } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";
import "./payments.css";

const periods = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" },
] as const;
type Period = (typeof periods)[number]["value"];

/** Start of the period at midnight in the facility's time zone, as an ISO instant. */
function periodStart(period: Period, zone: string) {
  if (period === "all") return "";
  const today = zonedDay(zone);
  const first =
    period === "7d" ? addCalendarDays(today, -6)
    : period === "30d" ? addCalendarDays(today, -29)
    : period === "month" ? today.slice(0, 8) + "01"
    : today;
  return zonedDayStart(first, zone);
}

export function StaffPayments() {
  const [offset, setOffset] = useState(0),
    [userId, setUserId] = useState(""),
    [period, setPeriod] = useState<Period>("all"),
    [from, setFrom] = useState(""),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState<number | null>(null),
    [notice, setNotice] = useState("");
  // Periods are facility days; the period filter waits until the zone is known.
  const zone = useFacilityZone();
  const query = new URLSearchParams({ offset: String(offset) });
  if (userId) query.set("userId", userId);
  if (from) query.set("from", from);
  if (status) query.set("status", status);
  // Saving keeps the table on screen while it refreshes; a new filter or page loads fresh.
  const payments = useApi<PaymentPage>(`/admin/payments?${query}`, { retainOnReload: true });
  const filtered = Boolean(userId || from || status);
  const refilter = (change: () => void) => {
    change();
    setOffset(0);
    setOpen(null);
    setNotice("");
  };
  const noticeRef = useRef<HTMLParagraphElement>(null),
    refocus = useRef(false);
  const done = (message: string) => {
    setOpen(null);
    setNotice(message);
    refocus.current = true;
    payments.reload();
  };
  const page = payments.data;
  // If the saved payment left these results (or the table emptied), focus would fall to the page: keep it on the notice.
  useEffect(() => {
    if (!refocus.current || payments.refreshing) return;
    refocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) noticeRef.current?.focus();
  }, [page, payments.refreshing]);
  const summary = page?.summary;

  return (
    <section className="payments">
      <p className="payments__intro">
        Every payment: what members paid at the front desk and their card payments online.
      </p>
      <div className="management-search payments__filters" role="group" aria-label="Filter payments">
        <MemberSelect
          label="Member"
          required={false}
          value={userId}
          onChange={(id) => refilter(() => setUserId(id))}
        />
        <label>
          Period
          <select
            value={period}
            disabled={!zone}
            onChange={(e) => {
              if (!zone) return;
              const next = e.target.value as Period;
              refilter(() => {
                setPeriod(next);
                setFrom(periodStart(next, zone));
              });
            }}
          >
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => refilter(() => setStatus(e.target.value))}>
            <option value="">Any status</option>
            {["pending", "paid", "refunded", "void", "waived"].map((s) => (
              <option key={s} value={s}>
                {paymentStatusName(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summary ? (
        <dl className="payments__summary" aria-label="Totals for these payments">
          <div>
            <dt>Collected</dt>
            <dd>{dollars(summary.collected)}</dd>
          </div>
          <div className={summary.pendingCount ? "is-warn" : undefined}>
            <dt>Awaiting payment</dt>
            <dd>
              {dollars(summary.pending)}
              <small>
                {summary.pendingCount} {summary.pendingCount === 1 ? "payment" : "payments"}
              </small>
            </dd>
          </div>
          <div>
            <dt>Refunded</dt>
            <dd>{dollars(summary.refunded)}</dd>
          </div>
          <div>
            <dt>Payments</dt>
            <dd>{summary.count}</dd>
          </div>
        </dl>
      ) : null}

      {/* Saving closes the editor, so the result is confirmed here. */}
      <p role="status" ref={noticeRef} tabIndex={-1} className={notice ? "payments__notice" : "sr-only"}>
        {notice}
      </p>

      <LoadState {...payments} loading={payments.loading && !page} />
      {page ? (
        page.items.length ? (
          <PaymentTable
            items={page.items}
            caption={`Payments ${offset + 1}–${offset + page.items.length} of ${summary?.count ?? page.items.length}, newest first`}
            open={open}
            onOpen={(id) => {
              setOpen(id);
              if (id !== null) setNotice("");
            }}
            onChanged={done}
          />
        ) : (
          <div className="payments__empty">
            <p>{filtered ? "No payments match these filters." : "No payments yet."}</p>
            {filtered ? (
              <button
                type="button"
                className="button button--quiet"
                onClick={() =>
                  refilter(() => {
                    setUserId("");
                    setPeriod("all");
                    setFrom("");
                    setStatus("");
                  })
                }
              >
                Clear filters
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {page ? (
        <Pager
          offset={offset}
          nextOffset={page.nextOffset}
          onChange={(next) => {
            setOffset(next);
            setOpen(null);
            setNotice("");
          }}
        />
      ) : null}
    </section>
  );
}
