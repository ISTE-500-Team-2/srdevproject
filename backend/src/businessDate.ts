/** The facility's default business time zone when none is configured. */
export const DEFAULT_BUSINESS_ZONE = "America/New_York";

/** Today's calendar date (YYYY-MM-DD) in the given business time zone. */
export function businessToday(zone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
