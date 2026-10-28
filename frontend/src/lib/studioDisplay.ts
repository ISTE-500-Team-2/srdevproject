import type { Studio } from "./studioContracts";

export const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
export const policy = (p: string | null) =>
  p === "full_before_start"
    ? "Full refund if you cancel before the start date. No refund on or after it."
    : p === "no_refunds"
      ? "No refunds once booked. Cancelling frees the studio for other members."
      : "Rental terms not set.";
export const dateOnly = (s: string) => s.slice(0, 10);
export function nextMonth(s: string) {
  if (!s) return "";
  const d = new Date(s + "T00:00:00Z");
  if (!Number.isFinite(d.getTime())) return "";
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  end.setUTCDate(
    Math.min(
      d.getUTCDate(),
      new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    ),
  );
  return end.toISOString().slice(0, 10);
}

/** Shifts a YYYY-MM-DD date by whole days without local-timezone drift. */
export function addDays(s: string, days: number) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Formats a YYYY-MM-DD calendar date, e.g. "Mon, Nov 2, 2026". */
export function calendarDate(
  s: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  },
) {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
    new Date(dateOnly(s) + "T00:00:00Z"),
  );
}

/** Rental end dates are exclusive; members see the last day they have the studio. */
export function rentalRange(start: string, endExclusive: string) {
  const last = addDays(dateOnly(endExclusive), -1);
  const sameYear = dateOnly(start).slice(0, 4) === last.slice(0, 4);
  const from = calendarDate(
    start,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${from} – ${calendarDate(last, { month: "short", day: "numeric", year: "numeric" })}`;
}

export const sizeKey = (size: string) => size.toLowerCase();
export const sizeLabel = (size: string) =>
  size.charAt(0).toUpperCase() + size.slice(1).toLowerCase();
export const SIZE_ORDER = ["small", "medium", "large"];
export function studioImage(size: string) {
  const images: Record<string, string> = {
    large: "paris",
    medium: "coruscant",
    small: "harkonnen",
  };
  return "/assets/space-" + (images[sizeKey(size)] ?? "harkonnen") + ".webp";
}

/** A studio is offered to members only once staff confirmed its rate and terms. */
export const bookable = (s: Studio) => s.policy_confirmed && !!s.monthly_cents;

/** The rental that blocks [start, end), if any. End dates are exclusive. */
export function conflictFor(s: Studio, start: string, end: string) {
  return s.availability.find(
    (r) => dateOnly(r.starts_on) < end && dateOnly(r.ends_on) > start,
  );
}

export const freeFor = (s: Studio, start: string) =>
  !conflictFor(s, start, nextMonth(start));

/** First start date within the horizon where any studio is free for a full month. */
export function nextOpening(studios: Studio[], today: string, horizonDays = 365) {
  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i);
    if (studios.some((s) => freeFor(s, date))) return date;
  }
  return null;
}
