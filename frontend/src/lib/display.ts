export function localInput(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function zonedDay(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export const dollars = (value: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(value),
  );
// Minutes are enough for people; seconds read as raw machine output.
export const dateTime = (value?: string | Date) =>
  value
    ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "Not recorded";
export const cents = (value: number) => dollars((value / 100).toFixed(2));
/** "Fri, Nov 3" for a timestamp or a YYYY-MM-DD calendar date. */
export function shortDate(value: string | Date, withYear = false) {
  const date =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00`)
      : new Date(value);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
const statusWords: Record<string, string> = {
  active: "Active",
  trialing: "Active",
  scheduled: "Starts soon",
  pending: "Payment pending",
  paid: "Paid",
  past_due: "Payment overdue",
  unpaid: "Payment overdue",
  incomplete: "Payment pending",
  incomplete_expired: "Checkout expired",
  canceled: "Cancelled",
  cancelled: "Cancelled",
  expired: "Ended",
  refunded: "Refunded",
  suspended: "On hold",
  revoked: "Revoked",
  failed: "Failed",
  succeeded: "Refunded",
};
/** Turns stored status values into words a member would use. */
export function statusLabel(value: string) {
  return (
    statusWords[value] ??
    value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}
export type StatusTone = "ok" | "warn" | "neutral";
export function statusTone(value: string): StatusTone {
  if (["active", "trialing", "paid"].includes(value)) return "ok";
  if (["pending", "incomplete", "past_due", "unpaid", "scheduled", "suspended", "failed"].includes(value))
    return "warn";
  return "neutral";
}
export const timeOnly = (value: string | Date) =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
