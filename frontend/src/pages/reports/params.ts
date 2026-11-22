// The report's date range and grouping, read from and checked for the URL.

import { presetRange, revenuePoints, type Preset, type Range, type RevenuePeriod } from "../../lib/analytics";

export const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom dates" },
];
export const PERIODS: RevenuePeriod[] = ["daily", "weekly", "monthly"];

/** Throws with a message staff can act on when the range can't be reported. */
export const checkRange = (range: Range) => revenuePoints(range.from, range.to, range.period, []);

/** The report lives in the URL, so a bookmark or a shared link opens the same report. */
export function readParams(params: URLSearchParams, today: string): { preset: Preset; range: Range } {
  const asked = params.get("range") as Preset | null;
  const preset = PRESETS.some((p) => p.value === asked) ? (asked as Preset) : "month";
  const group = params.get("group") as RevenuePeriod | null;
  const period = group && PERIODS.includes(group) ? group : "weekly";
  if (preset === "custom") {
    const range = { from: params.get("from") ?? today, to: params.get("to") ?? today, period };
    try {
      checkRange(range);
      return { preset, range };
    } catch {
      // A hand-edited link with bad dates falls back to this month.
    }
  }
  return { preset: preset === "custom" ? "month" : preset, range: { ...presetRange(preset === "custom" ? "month" : preset, today), period } };
}
