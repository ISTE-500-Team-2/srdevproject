import type { Report } from "../pages/ReportsPage";
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
