import { useEffect, useMemo, useState, type ReactNode } from "react";

const QUICK_DAYS = 14;
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nextHalfHour = (d: Date) => {
  const next = new Date(d);
  // Always choose a future slot, including when the clock is exactly on a boundary.
  next.setMinutes(Math.floor(d.getMinutes() / 30) * 30 + 30, 0, 0);
  return next;
};
const timeLabel = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** Quick day buttons with future start times on half-hour boundaries. */
export function StartTimePicker({ name, hours, onPick, children, now: nowProp }: {
  name: string;
  hours: number;
  onPick?: () => void;
  children?: ReactNode;
  now?: Date;
}) {
  const [now, setNow] = useState(() => nowProp ?? new Date());
  useEffect(() => {
    if (nowProp) { setNow(nowProp); return; }
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, [nowProp]);
  const [day, setDay] = useState(() => dayKey(nextHalfHour(now)));
  const [time, setTime] = useState(() => clockKey(nextHalfHour(now)));
  const minimum = nextHalfHour(now);
  const days = useMemo(() => Array.from({ length: QUICK_DAYS }, (_, offset) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return { key: dayKey(date), date, offset };
  }), [now]);
  const chooseDay = (value: string) => {
    setDay(value);
    if (value === dayKey(now) && time < clockKey(minimum)) setTime(clockKey(minimum));
    onPick?.();
  };
  // A dialog can remain open across a slot boundary or midnight.
  useEffect(() => {
    const next = nextHalfHour(now);
    const nextDay = dayKey(next);
    if (day && day < nextDay) {
      setDay(nextDay);
      setTime(clockKey(next));
    } else if (day === nextDay && time < clockKey(next)) {
      setTime(clockKey(next));
    }
  }, [now, day, time]);
  const times = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`)
    .filter(value => day !== dayKey(minimum) || value >= clockKey(minimum));
  const [year, month, date] = day.split("-").map(Number);
  const chosen = new Date(year!, month! - 1, date!);
  const [hour, minute] = time.split(":").map(Number);
  const start = hour! * 60 + minute!;
  const end = start + hours * 60;
  const valid = !!day && !!time && Number.isFinite(chosen.getTime()) && Number.isFinite(start);
  return (
    <fieldset className="start-picker">
      <legend>Day</legend>
      <div className="start-picker__days" role="radiogroup" aria-label="Day">
        {days.map((d) => (
          <button key={d.key} type="button" role="radio" aria-checked={d.key === day}
            aria-label={d.date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            className="start-picker__day" disabled={d.key < dayKey(minimum)} onClick={() => chooseDay(d.key)}>
            <span>{d.offset === 0 ? "Today" : d.offset === 1 ? "Tomorrow" : d.date.toLocaleDateString([], { weekday: "short" })}</span>
            <strong>{d.date.getDate()}</strong>
            <small>{d.date.toLocaleDateString([], { month: "short" })}</small>
          </button>
        ))}
      </div>
      <label className="form-field">
        <span>Booking date</span>
        <input aria-label="Booking date" type="date" value={day} min={dayKey(minimum)} required onChange={(e) => chooseDay(e.target.value)} />
        <small>Choose any future date, including dates beyond the quick choices above.</small>
      </label>
      <label className="form-field">
        <span>Start time</span>
        <select aria-label="Start time" value={time} required
          onChange={(e) => { setTime(e.target.value); onPick?.(); }}>
          {times.map(value => <option key={value} value={value}>
            {timeLabel(Number(value.slice(0, 2)) * 60 + Number(value.slice(3)))}
          </option>)}
        </select>
        <small>{Intl.DateTimeFormat().resolvedOptions().timeZone} · bookings start on the hour or half-hour.</small>
      </label>
      {children}
      <p className="start-picker__summary" aria-live="polite">
        {valid ? <>{chosen.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {timeLabel(start)} – {timeLabel(end % (24 * 60))}{end >= 24 * 60 ? " the next day" : ""}</> : "Choose a date and start time."}
      </p>
      <input type="hidden" name={name} value={valid ? `${day}T${time}` : ""} />
    </fieldset>
  );
}
