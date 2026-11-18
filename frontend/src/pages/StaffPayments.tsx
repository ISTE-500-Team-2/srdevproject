// Staff payment search, summaries and record actions, using shared payment controls for permitted
// changes.

import { useEffect, useRef, useState } from "react";
import { MemberSelect } from "../components/MemberSelect";
import { KeptResults, useResultsPaging } from "../components/KeptResults";
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
function periodStart(period: Period, zone: string, today: string) {
  if (period === "all") return "";
  const first =
    period === "7d" ? addCalendarDays(today, -6)
    : period === "30d" ? addCalendarDays(today, -29)
    : period === "month" ? today.slice(0, 8) + "01"
    : today;
  return zonedDayStart(first, zone);
}

export function StaffPayments() {
  const [paging, setPaging] = useState({ offset: 0, from: "" }),
    [userId, setUserId] = useState(""),
    [period, setPeriod] = useState<Period>("all"),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState<number | null>(null),
    // `problem` marks a failure (a card refund Stripe didn't complete), shown as an alert rather than a confirmation.
    [notice, setNotice] = useState({ text: "", problem: false });
  // Periods are facility days; the period filter waits until the zone is known.
  const zone = useFacilityZone();
  // The facility day, re-checked each minute so "Today" and "This month" move on at midnight while the
  // page stays open; an unchanged day leaves the query, and so the results, as they are.
  const [today, setToday] = useState("");
  useEffect(() => {
    if (!zone) return;
    const check = () => setToday(zonedDay(zone));
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [zone]);
  const from = zone && today ? periodStart(period, zone, today) : "";
  // A page number belongs to the period it was chosen in: when "Today" moves on at midnight, the new
  // day starts from its first page rather than an empty page 3.
  const offset = paging.from === from ? paging.offset : 0;
  const setOffset = (next: number) => setPaging({ offset: next, from });
  const query = new URLSearchParams({ offset: String(offset) });
  if (userId) query.set("userId", userId);
  if (from) query.set("from", from);
  if (status) query.set("status", status);
  // Saving, a new filter or another page keeps the last results on screen until the new ones land,
  // so the page never collapses to a loading line and back (which flashed the scrollbar).
  const payments = useApi<PaymentPage>(`/admin/payments?${query}`, { retainOnReload: true, retainOnChange: true });
  const filtered = Boolean(userId || from || status);
  const refilter = (change: () => void) => {
    change();
    setOffset(0);
    setOpen(null);
    setNotice({ text: "", problem: false });
  };
  const filters = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null),
    refocus = useRef(false);
  const done = (message: string, problem = false) => {
    setOpen(null);
    setNotice({ text: message, problem });
    refocus.current = true;
    payments.reload();
  };
  const page = payments.data;
  const { results, turn, busy } = useResultsPaging(payments);
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
      <div className="management-search payments__filters" role="group" aria-label="Filter payments" ref={filters} tabIndex={-1}>
        <MemberSelect
          label="Member"
          required={false}
          value={userId}
          onChange={(id) => refilter(() => setUserId(id))}
        />
        {/* Payments are counted by the day they were recorded, not the day they were later paid or
            refunded, so the label says so for anyone reconciling a cash drawer. */}
        <label>
          Recorded
          <select
            value={period}
            disabled={!zone}
            onChange={(e) => {
              if (!zone) return;
              const next = e.target.value as Period;
              refilter(() => setPeriod(next));
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

      <KeptResults read={payments} ref={results}>
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
        <p
          role={notice.problem ? "alert" : "status"}
          ref={noticeRef}
          tabIndex={-1}
          className={notice.text ? (notice.problem ? "payments__notice payments__notice--problem" : "payments__notice") : "sr-only"}
        >
          {notice.text}
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
                if (id !== null) setNotice({ text: "", problem: false });
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
                  onClick={() => {
                    // The results wait faded while the filters change: hand focus to the filters first.
                    filters.current?.focus();
                    refilter(() => {
                      setUserId("");
                      setPeriod("all");
                      setStatus("");
                    });
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          )
        ) : null}
      </KeptResults>
      {page ? (
        <Pager
          offset={offset}
          nextOffset={page.nextOffset}
          busy={busy}
          onChange={(next) =>
            turn(() => {
              setOffset(next);
              setOpen(null);
              setNotice({ text: "", problem: false });
            })
          }
        />
      ) : null}
    </section>
  );
}
