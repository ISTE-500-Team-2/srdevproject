import type { Report } from "./reportContracts";
export type RevenuePeriod = "daily" | "weekly" | "monthly";
export type RevenuePoint = {
  period: string;
  gross: number;
  refunds: number;
  net: number;
  receipts: number;
};
const day = (date: Date) => date.toISOString().slice(0, 10);
export function shiftDay(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return day(date);
}
function bucketStart(value: string, period: RevenuePeriod) {
  const date = new Date(value + "T00:00:00Z");
  if (period === "weekly")
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (period === "monthly") date.setUTCDate(1);
  return day(date);
}
// The server owns timezone boundaries, settlement and refund rules. Aggregate
// its complete report, never a paginated payment-history screen or browser timestamps.
export function revenuePoints(
  from: string,
  to: string,
  period: RevenuePeriod,
  rows: Report["revenue"],
): RevenuePoint[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    throw Error("Choose valid report dates.");
  const start = Date.parse(from),
    end = Date.parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    day(new Date(start)) !== from ||
    day(new Date(end)) !== to ||
    end < start ||
    end - start > 92 * 86400000
  )
    throw Error("Choose an inclusive range of at most 93 days.");
  const points = new Map<string, RevenuePoint>();
  for (let date = bucketStart(from, period); date <= to; ) {
    points.set(date, {
      period: date,
      gross: 0,
      refunds: 0,
      net: 0,
      receipts: 0,
    });
    if (period === "monthly") {
      const next = new Date(date + "T00:00:00Z");
      next.setUTCMonth(next.getUTCMonth() + 1);
      date = day(next);
    } else date = shiftDay(date, period === "weekly" ? 7 : 1);
  }
  for (const row of rows) {
    const point = points.get(row.period);
    if (!point) continue;
    for (const field of ["gross", "refunds", "net"] as const)
      point[field] += Math.round(Number(row[field]) * 100);
    point.receipts += row.receipts;
  }
  return [...points.values()].map((point) => ({
    ...point,
    gross: point.gross / 100,
    refunds: point.refunds / 100,
    net: point.net / 100,
  }));
}

/** The day after the last day of the period that starts on `start`. */
function nextBucket(start: string, period: RevenuePeriod) {
  if (period === "daily") return shiftDay(start, 1);
  if (period === "weekly") return shiftDay(start, 7);
  const next = new Date(start + "T00:00:00Z");
  next.setUTCMonth(next.getUTCMonth() + 1);
  return day(next);
}
const dayCount = (from: string, until: string) => Math.round((Date.parse(until) - Date.parse(from)) / 86400000);

/**
 * How much of a period the range covers. "Last 30 days" ending on a Tuesday
 * leaves a two-day last week, which must not read like a slow week.
 */
export function periodCoverage(start: string, period: RevenuePeriod, from: string, to: string) {
  const end = nextBucket(start, period);
  const first = start > from ? start : from;
  const afterLast = end < shiftDay(to, 1) ? end : shiftDay(to, 1);
  return { days: Math.max(0, dayCount(first, afterLast)), total: dayCount(start, end) };
}

export type VisitPoint = { period: string; visits: number };

/** Daily visits summed into the same periods the revenue chart uses. */
export function visitPoints(
  from: string,
  to: string,
  period: RevenuePeriod,
  days: Report["visitsByDay"],
): VisitPoint[] {
  const points = new Map<string, VisitPoint>();
  for (let date = bucketStart(from, period); date <= to; date = nextBucket(date, period))
    points.set(date, { period: date, visits: 0 });
  for (const { day: date, visits } of days) {
    const point = points.get(bucketStart(date, period));
    if (point && date >= from && date <= to) point.visits += visits;
  }
  return [...points.values()];
}

/**
 * What the same days added up to one comparison period earlier. Only the days of
 * the bar that are inside the range count, so a two-day last week is compared
 * with two days, never with a full week.
 */
export function earlierTotal(
  start: string,
  period: RevenuePeriod,
  range: { from: string; to: string },
  earlier: { from: string; to: string },
  daily: Map<string, number>,
) {
  const offset = dayCount(earlier.from, range.from);
  const end = nextBucket(start, period);
  let total = 0;
  for (let date = start > range.from ? start : range.from; date < end && date <= range.to; date = shiftDay(date, 1)) {
    const then = shiftDay(date, -offset);
    if (then >= earlier.from && then <= earlier.to) total += daily.get(then) ?? 0;
  }
  return total;
}

/** How many Mondays, Tuesdays... a range holds; 30 days always has some weekdays twice more often. */
export function weekdayCounts(from: string, to: string) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let date = from; date <= to; date = shiftDay(date, 1)) counts[(new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7]++;
  return counts;
}
