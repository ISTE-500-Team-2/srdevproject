// The Daily / Weekly / Monthly switch on Analytics and Reports. It is announced as a radio group,
// so it behaves like one: a single Tab stop on the chosen option, and the arrow keys (plus Home
// and End) move the choice, through the shared roving-focus helper.

import type { RevenuePeriod } from "../lib/analytics";
import { statusLabel } from "../lib/display";
import { onArrowKeys } from "../lib/rovingFocus";

const PERIODS: RevenuePeriod[] = ["daily", "weekly", "monthly"];

/** `value` is the grouping actually applied, so the switch never shows one the page has not used. */
export function PeriodSwitch({ label, value, onChange }: { label: string; value: RevenuePeriod; onChange: (period: RevenuePeriod) => void }) {
  return (
    <div className="analytics-period" role="radiogroup" aria-label={label} onKeyDown={onArrowKeys}>
      {PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          role="radio"
          aria-checked={value === period}
          tabIndex={value === period ? 0 : -1}
          onClick={() => onChange(period)}
        >
          {statusLabel(period)}
        </button>
      ))}
    </div>
  );
}
