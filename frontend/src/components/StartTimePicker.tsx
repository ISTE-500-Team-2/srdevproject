// Start-time picker exposes available slots while retaining keyboard navigation and the selected
// booking duration.

import { MonthCalendar } from "./MonthCalendar";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

const QUICK_DAYS = 14;
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/**
 * Slack over the server's rules (a start in the future; 30 minutes ahead when payment is due), so
 * the earliest start offered is still accepted when the member sends the form a little later.
 */
const MARGIN_MINUTES = 2;
/** The earliest start offered: the first hour or half hour, local time, past the lead time and margin. */
const minimumStart = (now: Date, leadMinutes: number) => {
  const minimum = new Date(now.getTime() + (leadMinutes + MARGIN_MINUTES) * 60000);
  // Round up counting seconds too: 10:00:20 is past 10:00.
  if (minimum.getMinutes() % 30 || minimum.getSeconds() || minimum.getMilliseconds())
    minimum.setMinutes(Math.floor(minimum.getMinutes() / 30) * 30 + 30, 0, 0);
  return minimum;
};
const timeLabel = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** Quick day buttons with future start times on half-hour boundaries. */
export function StartTimePicker({ name, hours, onPick, children, now: nowProp, calendar = false, occupied = [], unavailable = false, minLeadMinutes = 0 }: {
  /** Booked times; each keeps `gapMinutes` (default 15, the equipment gap) free on either side. */
  occupied?: {startTime: string; endTime: string; gapMinutes?: number}[];
  unavailable?: boolean;
  calendar?: boolean;
  minLeadMinutes?: number;
  name: string;
  hours: number;
  onPick?: () => void;
  children?: ReactNode;
  now?: Date;
}) {
  const initialNow = nowProp ?? new Date();
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    if (nowProp) { setNow(nowProp); return; }
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, [nowProp]);
  const [day, setDay] = useState(() => dayKey(minimumStart(initialNow, minLeadMinutes)));
  const [calendarMonth, setCalendarMonth] = useState(() => dayKey(minimumStart(initialNow, minLeadMinutes)).slice(0, 7));
  const [time, setTime] = useState(() => clockKey(minimumStart(initialNow, minLeadMinutes)));
  // Until the member chooses a start time, `time` is a suggestion that follows the clock and the free
  // times. A time they chose is never swapped for another: if it stops fitting, they are told.
  const [picked, setPicked] = useState(false);
  const noticeId = useId();
  const movedId = `${noticeId}moved`;
  const minimum = minimumStart(now, minLeadMinutes);
  const days = useMemo(() => Array.from({ length: QUICK_DAYS }, (_, offset) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return { key: dayKey(date), date, offset };
  }), [now]);
  const chooseDay = (value: string) => {
    setDay(value);
    onPick?.();
  };
  // A dialog can remain open across a slot boundary or midnight: keep the suggestion current. A day
  // and time the member chose stay put, even once passed; the notice below asks for new ones.
  useEffect(() => {
    if (picked) return;
    const next = minimumStart(now, minLeadMinutes);
    const nextDay = dayKey(next);
    if (day && day < nextDay) {
      setDay(nextDay);
      setTime(clockKey(next));
    } else if (day === nextDay && time < clockKey(next)) {
      setTime(clockKey(next));
    }
  }, [now, day, time, minLeadMinutes, picked]);
  // A calendar checks every half-hour on every visible day. Parse each booking
  // once per availability refresh, not again for every candidate start time.
  const occupiedIntervals = useMemo(() => occupied.map(slot => ({
    start: new Date(slot.startTime).getTime() - (slot.gapMinutes ?? 15) * 60000,
    end: new Date(slot.endTime).getTime() + (slot.gapMinutes ?? 15) * 60000,
  })), [occupied]);
  const availableTimes = (date: string) => Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`)
    .filter(value => {
      if (unavailable || date < dayKey(minimum) || (date === dayKey(minimum) && value < clockKey(minimum))) return false;
      const at = new Date(`${date}T${value}`);
      // Skip clock times a daylight-saving jump leaves out (2:00–2:59 AM on spring-forward day);
      // reservationInput rejects them.
      if (dayKey(at) !== date || clockKey(at) !== value) return false;
      const start = at.getTime();
      const end = start + hours * 3600000;
      return !occupiedIntervals.some(slot => start < slot.end && end > slot.start);
    });
  const times = availableTimes(day);
  // A suggestion moves on to the next free start; a chosen time that no longer fits leaves nothing chosen.
  const effectiveTime = times.includes(time) ? time : picked ? '' : times.find(value => value > time) ?? '';
  const [year, month, date] = day.split("-").map(Number);
  const chosen = new Date(year!, month! - 1, date!);
  const label = (value: string) => timeLabel(Number(value.slice(0, 2)) * 60 + Number(value.slice(3)));
  const unfit = (value: string) => `${label(value)} isn’t available for ${hours} ${hours === 1 ? "hour" : "hours"} on this day`;
  // A machine that is out of service has no start time on any day, so the chosen time is not at fault:
  // the reason is shown with the machine, not as advice to pick another time.
  const notice = !picked || !time || effectiveTime || unavailable ? '' :
    // A dialog left open past midnight: the chosen day itself has passed.
    day < dayKey(minimum) ? `${label(time)} on ${chosen.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} can no longer be booked. Choose another day and start time.`
    : day === dayKey(minimum) && time < clockKey(minimum) ? `${label(time)} can no longer be booked. Choose a later start time.`
    : `${unfit(time)}. Choose another start time.`;
  // What the select last showed. A suggestion that a longer booking or an availability refresh pushes
  // to another start is announced beside the field; a day the member picks, or the earliest start
  // moving with the clock or the payment lead time, needs no note.
  const minimumKey = `${dayKey(minimum)}T${clockKey(minimum)}`;
  const [shown, setShown] = useState({ day, time: effectiveTime, hours, minimumKey });
  const [moved, setMoved] = useState('');
  if (shown.day !== day || shown.time !== effectiveTime || shown.hours !== hours || shown.minimumKey !== minimumKey) {
    setShown({ day, time: effectiveTime, hours, minimumKey });
    if (!picked && !unavailable && shown.time && shown.time !== effectiveTime && shown.day === day && shown.minimumKey === minimumKey) {
      setMoved(effectiveTime ? `${unfit(shown.time)}, so the start time moved to ${label(effectiveTime)}.` : `${unfit(shown.time)}. Choose another start time.`);
      // Keep the new start, so it doesn't jump back if the earlier one frees up again.
      if (effectiveTime) setTime(effectiveTime);
    } else if (shown.day !== day || shown.time !== effectiveTime || shown.hours !== hours) setMoved('');
  }
  const [hour, minute] = effectiveTime.split(":").map(Number);
  const start = hour! * 60 + minute!;
  // A booking lasts `hours` of elapsed time (see reservationInput), which differs from the
  // clock difference when it crosses a daylight-saving change.
  const end = new Date(new Date(`${day}T${effectiveTime}`).getTime() + hours * 3600000);
  const valid = !!day && !!effectiveTime && Number.isFinite(chosen.getTime()) && Number.isFinite(start) && Number.isFinite(end.getTime());
  return (
    <fieldset className={calendar ? "start-picker start-picker--calendar" : "start-picker"}>
      <legend className={calendar ? "sr-only" : undefined}>Day</legend>
      {calendar ? <MonthCalendar month={calendarMonth} setMonth={setCalendarMonth} today={dayKey(now)} selected={day} isValid={value => availableTimes(value).length > 0} onSelect={chooseDay} /> : <>
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
      </>}
      <div className="start-picker__controls">
      <label className="form-field">
        <span>Start time</span>
        <select aria-label="Start time" value={effectiveTime} required
          aria-invalid={notice ? true : undefined} aria-describedby={notice ? noticeId : moved ? movedId : undefined}
          onChange={(e) => { setTime(e.target.value); setPicked(true); onPick?.(); }}>
          {!effectiveTime && <option value="">{times.length ? "Choose a start time" : "No available times"}</option>}
          {times.map(value => <option key={value} value={value}>{label(value)}</option>)}
        </select>
        {notice && <small className="form-field__error" id={noticeId} role="alert">{notice}</small>}
        {moved && <small id={movedId} role="status">{moved}</small>}
      </label>
      {children}
      <p className="start-picker__hint">{Intl.DateTimeFormat().resolvedOptions().timeZone} · Hour or half-hour starts.{minLeadMinutes ? ` Book at least ${minLeadMinutes} minutes ahead.` : ''}</p>
      <p className="start-picker__summary" aria-live="polite">
        {valid ? <>{chosen.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {timeLabel(start)} – {timeLabel(end.getHours() * 60 + end.getMinutes())}{dayKey(end) !== day ? " the next day" : ""}</> : "Choose a date and start time."}
      </p>
      </div>
      <input type="hidden" name={name} value={valid ? `${day}T${effectiveTime}` : ""} />
    </fieldset>
  );
}
