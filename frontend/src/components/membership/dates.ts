import { shortDate } from "../../lib/display";

/**
 * Day passes can be cancelled until midnight at the start of the day three
 * days before the visit, so the last full day to cancel is four days before.
 */
export function lastCancelDay(validDate: string) {
  const d = new Date(`${validDate}T12:00:00`);
  d.setDate(d.getDate() - 4);
  return shortDate(d);
}
