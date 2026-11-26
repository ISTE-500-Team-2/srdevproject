// Sums across a report's rows, used by the cards and the panels' totals.

import type { Report } from "../../lib/reportContracts";
import { cents } from "./format";

export function totals(r: Report) {
  const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const cohorts = Object.entries(r.notifications?.cohorts ?? {});
  const due = sum(cohorts, ([, c]) => c.eligible);
  return {
    net: cents(sum(r.revenue, (x) => Number(x.net))),
    gross: cents(sum(r.revenue, (x) => Number(x.gross))),
    refunds: cents(sum(r.revenue, (x) => Number(x.refunds))),
    receipts: sum(r.revenue, (x) => x.receipts),
    joined: sum(r.memberships ?? [], (x) => x.newMembers),
    ended: sum(r.memberships ?? [], (x) => x.endedWithoutRenewingMembers),
    cancelled: sum(r.memberships ?? [], (x) => x.cancelledMembers),
    cohorts,
    due,
    onTime: due ? (100 * sum(cohorts, ([, c]) => c.delivery_on_time)) / due : null,
    deliveredOnTime: sum(cohorts, ([, c]) => c.delivery_on_time),
  };
}
