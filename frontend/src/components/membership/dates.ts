import { addCalendarDays } from "../../lib/calendarDate";
import { shortDate } from "../../lib/display";

/**
 * Day passes can be cancelled until midnight at the start of the day three
 * days before the visit, so the last full day to cancel is four days before.
 * Returned as YYYY-MM-DD so it compares with the facility's `today`.
 */
export function lastCancelDate(validDate: string) {
  return addCalendarDays(validDate, -4);
}

export function lastCancelDay(validDate: string) {
  return shortDate(lastCancelDate(validDate));
}
