// Member room booking on the Equipment page. Rooms carry no price: a room booking is a free hourly
// reservation under the same server rules as equipment (whole hours, membership over the booked time,
// a 15-minute gap between the member's own bookings for one room, 24 hours' notice to cancel).

import { CalendarDays, DoorOpen } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError, errorMessage } from '../lib/api';
import { reservationInput } from '../lib/reservationInput';
import { useApi } from '../lib/useApi';
import { Modal } from './Modal';
import { StartTimePicker } from './StartTimePicker';

/** A GET /rooms row: booked times only, `mine` marking the member's own bookings. */
export type BookableRoom = {
  id: number;
  name: string;
  location: string;
  capacity: number | null;
  status: string;
  occupied: { startTime: string; endTime: string; mine: boolean }[];
};

/** Other members' bookings only block their own hours; the member's own need a 15-minute gap. */
const pickerSlots = (room: BookableRoom) =>
  room.occupied.map(slot => ({ startTime: slot.startTime, endTime: slot.endTime, gapMinutes: slot.mine ? 15 : 0 }));

export function RoomBooking({ onBooked }: { onBooked: (message: string) => void }) {
  const { user } = useAuth();
  const instructor = !!user?.roles.includes('instructor');
  const rooms = useApi<BookableRoom[]>('/rooms', { retainOnReload: true });
  const [selected, setSelected] = useState<BookableRoom | null>(null);
  const [duration, setDuration] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  // Other bookings land while the dialog is open: keep its free times current.
  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => rooms.reload(), 15000);
    return () => window.clearInterval(timer);
  }, [selected?.id]);
  const live = rooms.data?.find(room => room.id === selected?.id) ?? selected;
  const list = rooms.data ?? [];

  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!live || inFlight.current) return;
    const form = new FormData(event.currentTarget);
    if (!form.get('start')) { setError('Choose an available date and time.'); return; }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const { startTime, endTime } = reservationInput(live.id, String(form.get('start')), Number(form.get('duration')));
      await api('/reservations', { method: 'POST', body: { roomId: live.id, startTime, endTime } });
      setSelected(null);
      onBooked('Reservation confirmed for ' + live.name + '.');
    } catch (err) {
      setError(err instanceof RangeError ? err.message
        : err instanceof ApiError && err.code === 'RESERVATION_CONFLICT'
          ? 'This room is already booked during your selected time. Choose another start time or shorten the duration, then try again.'
          : errorMessage(err));
    } finally {
      rooms.reload();
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="reservation-section" id="rooms" aria-labelledby="rooms-heading">
      <div className="reservation-section__heading">
        <div>
          <p className="eyebrow">Free to book by the hour</p>
          <h2 id="rooms-heading">Rooms</h2>
        </div>
      </div>
      {instructor ? <p className="form-notice">Instructor accounts can’t book rooms. Staff schedule rooms for classes.</p> : null}
      {rooms.error ? (
        <p role="alert" className="form-error">{rooms.error} <button onClick={rooms.reload}>Retry</button></p>
      ) : null}
      {rooms.loading ? <p className="empty-state">Loading rooms…</p> : null}
      {!rooms.loading && !rooms.error && !list.length ? <p className="empty-state">No rooms are set up yet.</p> : null}
      {list.length ? (
        <div className="equipment-grid room-grid">
          {list.map(room => {
            const open = room.status === 'available' && !instructor;
            return (
              <article className={`reservation-card room-card${open ? '' : ' room-card--closed'}`} key={room.id}>
                <div className="reservation-card__rule" />
                <div className="reservation-card__title"><h3>
                  {open ? (
                    <button type="button" className="reservation-card__open" aria-describedby={`room-details-${room.id}`}
                      onClick={() => { setSelected(room); setDuration(1); setError(''); }}>{room.name}</button>
                  ) : room.name}
                </h3><DoorOpen aria-hidden="true" /></div>
                <p className="equipment-card__names" id={`room-details-${room.id}`}>
                  {[room.location, room.capacity != null ? `Seats ${room.capacity}` : '', room.status === 'available' ? '' : 'Not available for booking']
                    .filter(Boolean).join(' · ')}
                </p>
              </article>
            );
          })}
        </div>
      ) : null}
      <Modal
        open={!!selected}
        title={live ? 'Reserve ' + live.name : 'Reserve a room'}
        onClose={() => { if (!busy) { setSelected(null); setError(''); } }}
      >
        {live ? (
          <form className="reservation-form equipment-reservation-form" onSubmit={reserve} onChange={() => setError('')}>
            <section aria-labelledby="room-time-heading">
              <h3 className="equipment-booking-step" id="room-time-heading"><span>1</span> Start date</h3>
              <StartTimePicker calendar occupied={pickerSlots(live)} unavailable={live.status !== 'available'} name="start" hours={duration} onPick={() => setError('')}>
                <label className="form-field">
                  <span>Duration</span>
                  <select name="duration" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                    {Array.from({ length: 24 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? 'hour' : 'hours'}</option>)}
                  </select>
                </label>
              </StartTimePicker>
            </section>
            <p className="equipment-payment-note">Rooms are free to book. No payment is required.</p>
            <p className="form-caption">
              Cancel at least 24 hours before the start time. Leave 15 minutes between your bookings for the same room.
              {' '}Your membership or day pass must cover the booked time, and the room’s reader opens only during it once your
              {' '}<Link to="/certifications">facility waivers</Link> are signed.
            </p>
            {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">{error}</p> : null}
            <button className="button button--primary equipment-booking-submit" type="submit" disabled={busy || live.status !== 'available'}>
              <CalendarDays aria-hidden="true" /> {busy ? 'Confirming reservation…' : 'Confirm reservation'}
            </button>
          </form>
        ) : null}
      </Modal>
    </section>
  );
}
