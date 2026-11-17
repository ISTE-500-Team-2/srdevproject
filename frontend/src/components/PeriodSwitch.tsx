// The Daily / Weekly / Monthly switch on Analytics and Reports. It is announced as a radio group,
// so it behaves like one: a single Tab stop on the chosen option, and the arrow keys move the choice.

import type { KeyboardEvent } from "react";
import type { RevenuePeriod } from "../lib/analytics";
import { statusLabel } from "../lib/display";

const PERIODS: RevenuePeriod[] = ["daily", "weekly", "monthly"];
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** `value` is the grouping actually applied, so the switch never shows one the page has not used. */
export function PeriodSwitch({ label, value, onChange }: { label: string; value: RevenuePeriod; onChange: (period: RevenuePeriod) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const to = (from + step + PERIODS.length) % PERIODS.length;
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[to]?.focus();
    onChange(PERIODS[to]);
  };
  return (
    <div className="analytics-period" role="radiogroup" aria-label={label}>
      {PERIODS.map((period, index) => (
        <button
          key={period}
          type="button"
          role="radio"
          aria-checked={value === period}
          tabIndex={value === period ? 0 : -1}
          onClick={() => onChange(period)}
          onKeyDown={(event) => move(event, index)}
        >
          {statusLabel(period)}
        </button>
      ))}
    </div>
  );
}
