// Pure chart aggregations fill time buckets and calculate comparisons from report data.

import type { Report } from "./reportContracts";
import { addCalendarDays as shiftDay } from "./calendarDate";
export type RevenuePeriod = "daily" | "weekly" | "monthly";
export type RevenuePoint = {
  period: string;
  gross: number;
  refunds: number;
  net: number;
  receipts: number;
};
const day = (date: Date) => date.toISOString().slice(0, 10);
/** A YYYY-MM-DD date moved by whole days; see addCalendarDays. */
export { shiftDay };
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
 * with two days, never with a full week. Undefined when none of the bar's days
 * has an earlier day to compare with (March 29-31 against February), so the bar
 * shows no comparison rather than an earlier total of zero.
 */
export function earlierTotal(
  start: string,
  period: RevenuePeriod,
  range: { from: string; to: string },
  earlier: { from: string; to: string },
  daily: Map<string, number>,
): number | undefined {
  const offset = dayCount(earlier.from, range.from);
  const end = nextBucket(start, period);
  let total: number | undefined;
  for (let date = start > range.from ? start : range.from; date < end && date <= range.to; date = shiftDay(date, 1)) {
    const then = shiftDay(date, -offset);
    if (then >= earlier.from && then <= earlier.to) total = (total ?? 0) + (daily.get(then) ?? 0);
  }
  return total;
}

/** How many Mondays, Tuesdays... a range holds; 30 days always has some weekdays twice more often. */
export function weekdayCounts(from: string, to: string) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let date = from; date <= to; date = shiftDay(date, 1)) counts[(new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7]++;
  return counts;
}

// ---------- Date ranges shared by the Analytics and Reports pages ----------
export type Preset = "today" | "week" | "month" | "30" | "90" | "custom";
export type Range = { from: string; to: string; period: RevenuePeriod };

/** "Eastern Time" rather than "America/New_York". */
export function zoneName(zone: string) {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? zone
    );
  } catch {
    return zone;
  }
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

export function presetRange(preset: Exclude<Preset, "custom">, today: string) {
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") {
    const weekday = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;
    return { from: shiftDay(today, -weekday), to: today };
  }
  if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
  return { from: shiftDay(today, preset === "30" ? -29 : -89), to: today };
}

/**
 * What the range is compared with. "This week" through Tuesday compares with
 * Monday and Tuesday of last week, not with the weekend just before it; "This
 * month" through the 10th compares with the 1st to the 10th of last month.
 * Always by day, so each bar can be compared with exactly its own days.
 */
export function previousRange(range: { from: string; to: string }, preset: Preset): Range {
  if (preset === "week") return { from: shiftDay(range.from, -7), to: shiftDay(range.to, -7), period: "daily" };
  if (preset === "month") {
    const start = new Date(range.from + "T00:00:00Z");
    start.setUTCMonth(start.getUTCMonth() - 1);
    const from = start.toISOString().slice(0, 10);
    const sameDay = shiftDay(from, Number(range.to.slice(8)) - 1);
    const monthEnd = shiftDay(range.from, -1);
    return { from, to: sameDay < monthEnd ? sameDay : monthEnd, period: "daily" };
  }
  const length = daysBetween(range.from, range.to);
  return { from: shiftDay(range.from, -length), to: shiftDay(range.from, -1), period: "daily" };
}

/** "vs last week" on the headline cards; "a week earlier" on a single bar. */
export function comparison(preset: Preset, range: { from: string; to: string }) {
  if (preset === "week") return { unit: "last week", earlier: "a week earlier" };
  if (preset === "month") return { unit: "last month", earlier: "a month earlier" };
  const length = daysBetween(range.from, range.to);
  // A one-day range is compared with "the previous day", not "the previous 1 days".
  if (length === 1) return { unit: "the previous day", earlier: "a day earlier" };
  return { unit: `the previous ${length} days`, earlier: `${length} days earlier` };
}
