export const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
export const policy = (p: string | null) =>
  p === "full_before_start"
    ? "Full refund if cancelled before the start date. No refund on or after the start date."
    : p === "no_refunds"
      ? "No refunds. Cancellation releases the studio for other members."
      : "Rental policy not configured.";
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
