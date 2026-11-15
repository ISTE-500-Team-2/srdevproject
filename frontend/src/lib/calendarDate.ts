/**
 * `ymd` (a YYYY-MM-DD calendar date) moved by `n` whole days. The arithmetic
 * runs in UTC, so no local daylight-saving change can shift the result.
 */
export function addCalendarDays(ymd: string, n: number) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
