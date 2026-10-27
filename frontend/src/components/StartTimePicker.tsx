import { useMemo, useState, type ReactNode } from "react";

const DAYS = 14;
const STEP_MINUTES = 30;

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeLabel = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** The next half-hour after `now`, in minutes since midnight. */
const nextSlot = (now: Date) =>
  Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / STEP_MINUTES) * STEP_MINUTES;

/**
 * Pick a day from the next two weeks, then a start time on the half hour.
 * Submits as a hidden `name` field in the `YYYY-MM-DDTHH:MM` local format the
 * native datetime-local input used, so the form's handling is unchanged.
 */
export function StartTimePicker({
  name,
  hours,
  onPick,
  children,
  now: nowProp,
}: {
  name: string;
  hours: number;
  /** Called whenever the member picks a day or time. */
  onPick?: () => void;
  /** Extra fields (such as duration) shown above the summary. */
  children?: ReactNode;
  now?: Date;
}) {
  const [now] = useState(() => nowProp ?? new Date());
  const days = useMemo(() => {
    // Late at night there are no slots left today, so start from tomorrow.
    const first = nextSlot(now) >= 24 * 60 ? 1 : 0;
    return Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + first + i);
      return { key: dayKey(d), date: d, offset: first + i };
    });
  }, [now]);
  const [day, setDay] = useState(days[0]!.key);
  const today = day === dayKey(now);
  const slots = useMemo(() => {
    const from = today ? nextSlot(now) : 0;
    const list: number[] = [];
    for (let m = from; m < 24 * 60; m += STEP_MINUTES) list.push(m);
    return list;
  }, [today, now]);
  const [picked, setPicked] = useState<number | null>(null);
  // Keep the chosen time when it still exists on the new day, otherwise use
  // the first slot, so there is always a valid start.
  const start = picked !== null && slots.includes(picked) ? picked : slots[0]!;
  const chosen = days.find((d) => d.key === day)!;
  const endMinutes = start + hours * 60;
  const endsNextDay = endMinutes >= 24 * 60;
  const dayName = (d: { date: Date; offset: number }) =>
    d.offset === 0
      ? "Today"
      : d.offset === 1
        ? "Tomorrow"
        : d.date.toLocaleDateString([], { weekday: "short" });

  return (
    <fieldset className="start-picker">
      <legend>Day</legend>
      <div className="start-picker__days" role="radiogroup" aria-label="Day">
        {days.map((d) => (
          <button
            key={d.key}
            type="button"
            role="radio"
            aria-checked={d.key === day}
            aria-label={d.date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            className="start-picker__day"
            onClick={() => {
              setDay(d.key);
              onPick?.();
            }}
          >
            <span>{dayName(d)}</span>
            <strong>{d.date.getDate()}</strong>
            <small>{d.date.toLocaleDateString([], { month: "short" })}</small>
          </button>
        ))}
      </div>
      <label className="form-field">
        <span>Start time</span>
        <select
          value={start}
          onChange={(e) => {
            setPicked(Number(e.target.value));
            onPick?.();
          }}
        >
          {slots.map((m) => (
            <option key={m} value={m}>
              {timeLabel(m)}
            </option>
          ))}
        </select>
      </label>
      {children}
      <p className="start-picker__summary" aria-live="polite">
        {chosen.date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ·{" "}
        {timeLabel(start)} – {timeLabel(endMinutes % (24 * 60))}
        {endsNextDay ? " the next day" : ""}
      </p>
      <input type="hidden" name={name} value={`${day}T${pad(Math.floor(start / 60))}:${pad(start % 60)}`} />
    </fieldset>
  );
}
