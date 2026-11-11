import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, CircleX, Clock, CreditCard, Plus, TriangleAlert, Wrench, X } from "lucide-react";
import { MemberSelect } from "../../MemberSelect";
import { EquipmentPriceBreakdown } from "../../EquipmentPriceBreakdown";
import { api, errorMessage } from "../../../lib/api";
import type { EquipmentPrice, LiveEquipment, Reservation } from "../../../lib/contracts";
import { cents } from "../../../lib/display";
import { useApi } from "../../../lib/useApi";
import { addDays, formatTime, localHour, mergeBookings, previousDay, timeWindow } from "../../../lib/today";
import {
  bookedCents,
  canChange,
  dayLabel,
  hoursLabel,
  isActive,
  isRoom,
  lengthsFrom,
  paidOnline,
  reservationHours,
  reservationStatus,
  startSlots,
  timeRange,
} from "../../../lib/reservationSchedule";
import { useDayBookings } from "../../../pages/admin/useDayBookings";

const HOUR = 3_600_000;
const refresh = { retainOnReload: true, refreshInterval: 60000 };

function PanelHead({ eyebrow, title, onClose, closeLabel, titleRef }: { eyebrow: string; title: string; onClose?: () => void; closeLabel?: string; titleRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="res-panel__head">
      <div>
        <p className="eq-eyebrow">{eyebrow}</p>
        <h2 ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
      </div>
      {onClose ? (
        <button type="button" className="icon-button icon-button--small" onClick={onClose} aria-label={closeLabel}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function Note({ tone, icon, children }: { tone: "alert" | "hold" | "info"; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`res-note res-note--${tone}`}>
      {icon}
      <p>{children}</p>
    </div>
  );
}

/** The panel when nothing is open: reservations on this day that need staff, as on Today. */
export function NeedsPanel({
  day,
  today,
  zone,
  now,
  bookings,
  machines,
  loading,
  onOpen,
}: {
  day: string;
  today: string;
  zone: string;
  now: number;
  bookings: Reservation[];
  machines: LiveEquipment[];
  loading: boolean;
  onOpen: (reservation: Reservation) => void;
}) {
  const down = new Map(machines.filter((m) => m.status !== "available").map((m) => [m.id, m]));
  const upcoming = bookings.filter((b) => isActive(b) && Date.parse(b.endTime) > now);
  const affected = upcoming.filter((b) => b.equipmentId !== null && down.has(b.equipmentId));
  const unpaid = upcoming.filter((b) => b.status === "pending" && !(b.equipmentId !== null && down.has(b.equipmentId)));
  const count = affected.length + unpaid.length;
  return (
    <>
      <div className="today-panel-head">
        <h2 id="res-panel-title">Needs you</h2>
        {!loading && count ? <span className={`today-count${affected.length ? " res-count--alert" : " today-count--hot"}`}>{count}</span> : null}
      </div>
      <p className="res-panel__day">{dayLabel(day, today)}</p>
      {loading ? null : count ? (
        <>
          {affected.map((b) => (
            <div key={b.id} className="today-todo">
              <span className="today-todo-icon today-todo-icon--alert" aria-hidden="true">
                <Wrench />
              </span>
              <div>
                <span className="today-todo-title">{b.equipmentName} is out of service</span>
                <p className="today-todo-detail">
                  {b.memberName ?? `Member #${b.userId}`} has it {timeRange(b.startTime, b.endTime, zone)}. Move or cancel the reservation.
                </p>
                <button type="button" className="today-button" onClick={() => onOpen(b)}>
                  Review
                </button>
              </div>
            </div>
          ))}
          {unpaid.map((b) => (
            <div key={b.id} className="today-todo">
              <span className="today-todo-icon" aria-hidden="true">
                <CreditCard />
              </span>
              <div>
                <span className="today-todo-title">{b.memberName ?? `Member #${b.userId}`} hasn’t paid yet</span>
                <p className="today-todo-detail">
                  {b.equipmentName}, {timeRange(b.startTime, b.endTime, zone)}.
                  {b.holdUntil ? ` Released at ${formatTime(b.holdUntil, zone)} if unpaid.` : ""}
                </p>
                <button type="button" className="today-button" onClick={() => onOpen(b)}>
                  View
                </button>
              </div>
            </div>
          ))}
        </>
      ) : (
        <p className="today-empty">Nothing needs you on this day.</p>
      )}
      <p className="res-panel__hint">Click a reservation to open it, or click open time on a machine to book it.</p>
    </>
  );
}

const paymentText: Record<string, string> = { paid: "Paid", pending: "Not paid", refunded: "Refunded", void: "Void", waived: "Waived", expired: "Expired" };

/** One reservation: what it is, its payment, and what staff can do with it. */
export function ReservationDetails({
  reservation: r,
  machine,
  zone,
  now,
  today,
  onChange,
  onCancelled,
  onClose,
  titleRef,
}: {
  reservation: Reservation;
  machine: LiveEquipment | undefined;
  zone: string;
  now: number;
  today: string;
  onChange: () => void;
  onCancelled: (reservation: Reservation) => void;
  onClose: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const down = !!machine && machine.status !== "available";
  const status = reservationStatus(r, now, down);
  const ended = Date.parse(r.endTime) <= now;
  const price = bookedCents(r);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.startTime));
  const cancellable = isActive(r) && !ended;
  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      onCancelled(await api<Reservation>(`/admin/reservations/${r.id}/cancel`, { method: "POST" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="res-panel__body">
      <PanelHead eyebrow={`Reservation #${r.id}`} title={`${r.equipmentName}, ${timeRange(r.startTime, r.endTime, zone)}`} onClose={onClose} closeLabel="Close reservation" titleRef={titleRef} />
      <p className="res-panel__sub">
        {dayLabel(day, today)} · {r.location}
      </p>
      {isRoom(r) ? (
        <Note tone="info" icon={<CalendarClock aria-hidden="true" />}>
          Studio and room bookings are changed in <Link to="/admin/studios">Studios</Link>.
        </Note>
      ) : isActive(r) && !ended && down ? (
        <Note tone="alert" icon={<TriangleAlert aria-hidden="true" />}>
          {r.equipmentName} is out of service{machine?.outages?.find((o) => !o.endedAt)?.reason ? ` (${machine.outages.find((o) => !o.endedAt)!.reason})` : ""}. Move or cancel this reservation.
        </Note>
      ) : r.status === "pending" && !ended ? (
        <Note tone="hold" icon={<Clock aria-hidden="true" />}>
          Waiting for online payment.{r.holdUntil ? ` Released at ${formatTime(r.holdUntil, zone)} if unpaid.` : ""}
        </Note>
      ) : null}
      {paidOnline(r) && isActive(r) && !ended ? (
        <p className="res-panel__muted">Booked with online payment, so the time and machine can’t be changed here.</p>
      ) : null}
      <dl className="eq-facts res-facts">
        <div className="res-facts__wide">
          <dt>Member</dt>
          <dd>
            {r.memberName ?? `Member #${r.userId}`}
            <small>
              #{r.userId}
              {r.memberEmail ? ` · ${r.memberEmail}` : ""}
            </small>
            <Link className="res-facts__link" to={`/admin/members?member=${r.userId}`}>
              Open member
            </Link>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-pill--${status.tone}`}>{status.label}</span>
          </dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>
            {price == null ? "—" : cents(price)}
            <small>{hoursLabel(reservationHours(r))}</small>
          </dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{r.paymentStatus ? (paymentText[r.paymentStatus] ?? r.paymentStatus) : "—"}</dd>
        </div>
        <div>
          <dt>Requires</dt>
          <dd>{isRoom(r) ? "—" : (machine?.certification ?? "No certification")}</dd>
        </div>
      </dl>
      {confirming ? (
        <div className="res-confirm" role="group" aria-label="Cancel this reservation?">
          <p>
            <strong>Cancel this reservation?</strong> This frees {r.equipmentName} {timeRange(r.startTime, r.endTime, zone)} for {r.memberName ?? `member #${r.userId}`}. It can’t be undone here.
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="res-actions">
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Keep reservation
            </button>
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void cancel()}>
              {busy ? "Cancelling…" : "Cancel reservation"}
            </button>
          </div>
        </div>
      ) : canChange(r, now) || cancellable ? (
        <div className="res-actions">
          {canChange(r, now) ? (
            <button type="button" className={`button ${down ? "button--primary" : "button--quiet"}`} onClick={onChange}>
              <CalendarClock aria-hidden="true" /> Change time or machine
            </button>
          ) : null}
          {cancellable ? (
            <button type="button" className="button button--quiet" onClick={() => setConfirming(true)}>
              <CircleX aria-hidden="true" /> Cancel…
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type EditorStart = { reservation?: Reservation; equipmentId?: number; start?: number; day: string };

/** Book a machine for a member, or move an existing reservation. Taken times are disabled; the server checks again on save. */
export function ReservationEditor({
  from,
  machines,
  zone,
  now,
  today,
  onSaved,
  onClose,
  titleRef,
}: {
  from: EditorStart;
  machines: LiveEquipment[];
  zone: string;
  now: number;
  today: string;
  onSaved: (reservation: Reservation, created: boolean) => void;
  onClose: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const editing = from.reservation;
  const [userId, setUserId] = useState(editing ? String(editing.userId) : "");
  const [equipmentId, setEquipmentId] = useState(String(editing?.equipmentId ?? from.equipmentId ?? machines.find((m) => m.status === "available")?.id ?? ""));
  const [day, setDay] = useState(from.day < today ? today : from.day);
  const [start, setStart] = useState<number | null>(editing ? Date.parse(editing.startTime) : (from.start ?? null));
  const [hours, setHours] = useState(editing ? reservationHours(editing) : 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const machine = machines.find((m) => String(m.id) === equipmentId);
  const down = !!machine && machine.status !== "available";

  // The day's bookings, plus the evening before for anything running past midnight.
  const dayBookings = useDayBookings(day, refresh);
  const eveBookings = useDayBookings(previousDay(day), refresh);
  const loadingDay = !!(dayBookings.state ?? eveBookings.state);
  const dayStart = localHour(day, 0, zone), dayEnd = localHour(day, 24, zone);
  const own = mergeBookings(dayBookings.bookings, eveBookings.bookings).filter(
    (b) => String(b.equipmentId) === equipmentId && Date.parse(b.endTime) > dayStart && Date.parse(b.startTime) < dayEnd,
  );
  const slots = startSlots(day, zone, now, own, editing?.id);
  const slot = start === null ? undefined : slots.find((s) => s.at === start);
  const lengths = start === null ? [] : lengthsFrom(start, own, editing?.id);
  const fits = !!slot?.free && lengths.includes(hours);
  const quote = useApi<EquipmentPrice | null>(equipmentId ? `/equipment/${equipmentId}/quote?hours=${hours}` : null);
  const unchanged =
    !!editing && String(editing.equipmentId) === equipmentId && Date.parse(editing.startTime) === start && reservationHours(editing) === hours;
  const ready = !!userId && !!machine && !down && start !== null && fits && !loadingDay && !!quote.data && !quote.loading && !unchanged;

  // Another day keeps the same time of day.
  const chooseDay = (next: string) => {
    if (start !== null) setStart(localHour(next, 0, zone) + (start - localHour(day, 0, zone)));
    setDay(next);
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const window = timeWindow(now, zone, own, day);
  const span = window.end - window.start;
  const pos = (a: number, b: number) => ({
    left: `${((Math.max(a, window.start) - window.start) / span) * 100}%`,
    width: `${((Math.min(b, window.end) - Math.max(a, window.start)) / span) * 100}%`,
  });
  const groups = [
    { label: "Morning", from: 0, to: 12 },
    { label: "Afternoon", from: 12, to: 17 },
    { label: "Evening", from: 17, to: 24 },
  ].map((g) => ({ ...g, slots: slots.filter((s) => s.at >= localHour(day, g.from, zone) && s.at < localHour(day, g.to, zone)) }));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || start === null) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        ...(quote.data ? { expectedPrice: quote.data } : {}),
        userId: Number(userId),
        equipmentId: Number(equipmentId),
        roomId: null,
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + hours * HOUR).toISOString(),
        ...(editing ? { expectedRevision: editing.revision } : {}),
      };
      const saved = editing
        ? await api<Reservation>(`/admin/reservations/${editing.id}`, { method: "PATCH", body })
        : await api<Reservation>("/reservations", { method: "POST", body });
      onSaved(saved, !editing);
    } catch (err) {
      quote.reload();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="res-panel__body">
      <PanelHead
        eyebrow={editing ? `Reservation #${editing.id}` : "New reservation"}
        title={editing ? "Change time or machine" : "Book equipment"}
        onClose={onClose}
        closeLabel={editing ? "Back to the reservation" : "Discard new reservation"}
        titleRef={titleRef}
      />
      {editing ? <p className="res-panel__sub">{editing.memberName ?? `Member #${editing.userId}`}</p> : null}
      <form className="management-form res-editor" onSubmit={save} noValidate>
        {editing ? null : <MemberSelect value={userId} onChange={setUserId} />}
        <label className="form-field">
          Equipment
          <select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id} disabled={m.status !== "available" && String(m.id) !== equipmentId}>
                {m.name} ({m.type}){m.status !== "available" ? ", out of service" : ""}
              </option>
            ))}
          </select>
          {down ? (
            <small className="res-editor__bad">Out of service. Choose another machine.</small>
          ) : machine?.certification ? (
            <small>Requires {machine.certification}.</small>
          ) : null}
        </label>
        <fieldset className="res-editor__group">
          <legend>Day</legend>
          <div className="res-chips">
            {days.map((d) => (
              <button key={d} type="button" className="res-chip" aria-pressed={d === day} onClick={() => chooseDay(d)}>
                {d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : `${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${d}T12:00:00Z`))} ${Number(d.slice(8))}`}
              </button>
            ))}
          </div>
          <label className="res-editor__date">
            Other date
            <input type="date" min={today} value={days.includes(day) ? "" : day} onChange={(event) => event.target.value && chooseDay(event.target.value)} />
          </label>
        </fieldset>
        {machine ? (
          <div className="res-editor__group">
            <span className="res-editor__label">
              {machine.name}, {dayLabel(day, today, "short")}
            </span>
            <div className={`res-strip${down ? " res-strip--down" : ""}`} aria-hidden="true">
              {own.filter((b) => b.id !== editing?.id).map((b) => (
                <i key={b.id} style={pos(Date.parse(b.startTime), Date.parse(b.endTime))} />
              ))}
              {start !== null ? <i className="res-strip__mine" style={pos(start, start + hours * HOUR)} /> : null}
            </div>
            <div className="res-strip__ticks" aria-hidden="true">
              {window.ticks.map((t) => (
                <span key={t.fraction}>{t.label}</span>
              ))}
            </div>
          </div>
        ) : null}
        <fieldset className="res-editor__group">
          <legend>Start time</legend>
          {loadingDay ? <p className="res-panel__muted" role="status">Loading times…</p> : null}
          {!slots.length ? <p className="res-panel__muted">No start times left on this day.</p> : null}
          {groups.map((g) =>
            g.slots.length ? (
              <div key={g.label} className="res-times">
                <span className="res-times__label">{g.label}</span>
                {g.slots.map((s) => (
                  <button
                    key={s.at}
                    type="button"
                    className="res-chip"
                    aria-pressed={s.at === start}
                    disabled={!s.free || down || loadingDay}
                    aria-label={`${formatTime(s.at, zone)}${s.free ? "" : ", taken"}`}
                    onClick={() => setStart(s.at)}
                  >
                    {formatTime(s.at, zone, false)}
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {start !== null && !loadingDay && !down && !slot?.free ? <small className="res-editor__bad">That start is taken. Choose another time.</small> : null}
        </fieldset>
        <fieldset className="res-editor__group">
          <legend>Length</legend>
          <div className="res-chips">
            {[1, 2, 3, 4].map((h) => (
              <button key={h} type="button" className="res-chip" aria-pressed={h === hours} disabled={start !== null && !lengths.includes(h)} onClick={() => setHours(h)}>
                {hoursLabel(h)}
              </button>
            ))}
            <select className="res-chips__more" aria-label="Longer" value={hours > 4 ? hours : ""} onChange={(event) => event.target.value && setHours(Number(event.target.value))}>
              <option value="">Longer…</option>
              {Array.from({ length: 20 }, (_, i) => i + 5).map((h) => (
                <option key={h} value={h} disabled={start !== null && !lengths.includes(h)}>
                  {hoursLabel(h)}
                </option>
              ))}
            </select>
          </div>
          {start !== null && slot?.free && !lengths.includes(hours) && lengths.length ? (
            <small className="res-editor__bad">Only {hoursLabel(lengths.at(-1)!)} fit from this start.</small>
          ) : null}
        </fieldset>
        {start !== null ? (
          <p className="res-editor__when">
            {dayLabel(day, today)}, {timeRange(start, start + hours * HOUR, zone)}
          </p>
        ) : null}
        <EquipmentPriceBreakdown price={quote.data} />
        {editing && bookedCents(editing) != null && quote.data && quote.data.totalCents !== bookedCents(editing) ? (
          <p className="res-panel__muted">Booked at {cents(bookedCents(editing)!)}. The price is checked again when you save.</p>
        ) : null}
        {quote.error ? (
          <p role="alert" className="form-error">
            {quote.error}{" "}
            <button type="button" onClick={quote.reload}>
              Refresh price
            </button>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="res-actions">
          <button className="button button--primary" disabled={!ready || busy}>
            {editing ? <CalendarClock aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {busy ? "Saving…" : editing ? "Save changes" : "Book"}
          </button>
          <button type="button" className="button button--quiet" onClick={onClose}>
            {editing ? "Back" : "Discard"}
          </button>
        </div>
      </form>
      {dayBookings.loaders}
      {eveBookings.loaders}
    </div>
  );
}

/** Moves keyboard focus to the panel's heading whenever `key` changes, and brings the panel into view when it sits below the schedule. */
export function usePanelFocus(key: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (key === "needs") return;
    const frame = requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
      if (window.matchMedia?.("(max-width: 1240px)").matches) ref.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return ref;
}
