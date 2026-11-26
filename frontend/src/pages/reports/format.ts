// Number, date and period wording shared by the report's cards and tables.

import { type RevenuePeriod } from "../../lib/analytics";
import { dollars } from "../../lib/display";

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const cents = (value: number) => Math.round(value * 100) / 100;
export const money = (value: number) => dollars(String(cents(value)));
/** 1,234 rather than 1234. */
export const count = (value: number) => value.toLocaleString("en-US");
export const points = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

export const day = (value: string, options: Intl.DateTimeFormatOptions) =>
  new Date(value.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

/** A period's starting date, named the way staff say it. */
export function periodName(start: string, period: RevenuePeriod) {
  if (period === "monthly") return day(start, { month: "long", year: "numeric" });
  if (period === "weekly") return `Week of ${day(start, { month: "short", day: "numeric" })}`;
  return day(start, { weekday: "short", month: "short", day: "numeric" });
}

/** A week or month the date range only partly covers, such as the week a month starts in. */
export function isPartial(start: string, period: RevenuePeriod, from: string, to: string) {
  if (period === "daily") return false;
  const first = new Date(start.slice(0, 10) + "T12:00:00Z");
  const end =
    period === "weekly"
      ? new Date(first.getTime() + 6 * 864e5)
      : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
  return start.slice(0, 10) < from || end.toISOString().slice(0, 10) > to;
}

export function rangeName(from: string, to: string) {
  if (from === to) return day(from, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${day(from, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })} – ${day(to, { month: "short", day: "numeric", year: "numeric" })}`;
}

export const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);
/** Hours to one decimal everywhere on the page. */
export const hours = (value: number) => (value ? value.toFixed(1) : "0");

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const hourName = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;

/** "Nov 3, 6:00 PM": the year is already in the range above. */
export const classTime = (at: string, zone: string) =>
  new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
