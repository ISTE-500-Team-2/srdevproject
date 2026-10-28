import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

const QUICK_DAYS = 14;
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nextMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60000) * 60000 + 60000);
const timeLabel = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** Quick day buttons, plus unrestricted local date and minute-precision time inputs. */
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
  const [day, setDay] = useState(() => dayKey(nextMinute(now)));
  const [time, setTime] = useState(() => clockKey(nextMinute(now)));
  const minimum = nextMinute(now);
  const days = useMemo(() => Array.from({ length: QUICK_DAYS }, (_, offset) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return { key: dayKey(date), date, offset };
  }), [now]);
  const chooseDay = (value: string) => {
    setDay(value);
    if (value === dayKey(now) && time < clockKey(minimum)) setTime(clockKey(minimum));
    onPick?.();
  };
  const listId = useId();
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
        <input aria-label="Start time" type="time" step={60} value={time} min={day === dayKey(minimum) ? clockKey(minimum) : undefined}
          required list={listId} onChange={(e) => { setTime(e.target.value); onPick?.(); }} />
        <datalist id={listId}>
          {Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`)
            .filter((value) => day !== dayKey(minimum) || value >= clockKey(minimum))
            .map((value) => <option key={value} value={value} />)}
        </datalist>
        <small>{Intl.DateTimeFormat().resolvedOptions().timeZone} · choose any minute.</small>
      </label>
      {children}
      <p className="start-picker__summary" aria-live="polite">
        {valid ? <>{chosen.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {timeLabel(start)} – {timeLabel(end % (24 * 60))}{end >= 24 * 60 ? " the next day" : ""}</> : "Choose a date and start time."}
      </p>
      <input type="hidden" name={name} value={valid ? `${day}T${time}` : ""} />
    </fieldset>
  );
}
