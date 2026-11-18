// CSV and PDF exports list the same sections in the same order.
// Row sections hold arrays of records; summary sections hold one record each.
export const EXPORT_ROW_SECTIONS = [
  "revenue",
  "equipment",
  "patterns",
  "classes",
  "rooms",
  "live",
  "usage",
  "memberships",
] as const;
export const EXPORT_SUMMARY_SECTIONS = ["active", "compliance"] as const;

/**
 * A value as both exports print it. Dates (such as class start times) read as
 * sortable local "YYYY-MM-DD HH:mm" in the report's time zone, not the server's.
 */
export function exportValue(value: unknown, timeZone: string): unknown {
  if (!(value instanceof Date)) return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
