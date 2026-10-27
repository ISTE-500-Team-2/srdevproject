import { useAuth } from '../context/AuthContext';
import { CalendarDays, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { api, ApiError, errorMessage } from '../lib/api';
import type { LiveEquipment, Reservation } from '../lib/contracts';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';
import { dateTime } from "../lib/display";

export function EquipmentPage() {
  const {user}=useAuth();
  const canBookForOthers=!!user?.roles.some(r=>['staff','admin'].includes(r)) && !user.roles.includes('instructor');
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const bookings = useApi<Reservation[]>('/reservations');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const mutationInFlight = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [selected, setSelected] = useState<LiveEquipment | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const equipment = (catalog.data ?? []).filter(
    (item) =>
      (filter === 'all' ||
      (filter === 'ready' ? item.canReserve : item.trainingRequired)) &&
      `${item.name} ${item.type}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || mutationInFlight.current) return;
    mutationInFlight.current = true;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setToast(null);
    setError('');
    try {
      const input = reservationInput(
        selected.id,
        String(form.get('start')),
        Number(form.get('duration')),
      );
      const target=String(form.get('memberId')??'').trim();
      const result=await api<Reservation>('/reservations', { method: 'POST', body: {...input,...(canBookForOthers&&target?{userId:Number(target)}:{})} });
      setToast('Reservation saved for ' + selected.name + (result.userId!==user?.id?' for member #'+result.userId:'') + '.');
      setSelected(null);
      bookings.reload();
      catalog.reload();
    } catch (err) {
      setError(err instanceof RangeError ? err.message :
        err instanceof ApiError && err.code === 'RESERVATION_CONFLICT'
          ? 'This equipment is already reserved during your selected time. Choose another start time or shorten the duration, then try again.'
          : errorMessage(err));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const cancel = async (id: number) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setToast(null);
    setError('');
    try {
      await api('/reservations/' + id + '/cancel', { method: 'POST' });
      bookings.reload();
      setToast('Reservation cancelled.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="reservations-page page-enter">
      <section className="reservation-section" id="equipment" tabIndex={-1}>
        <div className="reservation-section__heading">
          <div>
            <p className="eyebrow">Reserve by the hour</p>
            <h1>Equipment</h1>
          </div>
          <label className="select-control">
            <Filter aria-hidden="true" />
            <span>Filter</span>
            <select
              aria-label="Equipment filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All equipment</option>
              <option value="ready">Eligible now</option>
              <option value="training">Training required</option>
            </select>
          </label>
        </div>
        <label className="form-field equipment-search">
          <span>Find equipment</span>
          <input type="search" value={search} placeholder="Search by name or type" onChange={e => setSearch(e.target.value)} />
        </label>
        {catalog.loading ? <p role="status">Loading equipment…</p> : null}
        {catalog.error ? (
          <p role="alert" className="form-error">
            {catalog.error} <button onClick={catalog.reload}>Retry</button>
          </p>
        ) : null}
        {!selected && error ? (
          <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="equipment-grid">
          {equipment.map((item) => (
            <button
              className="reservation-card equipment-card"
              key={item.id}
              onClick={() => {
                setSelected(item);
                setToast(null);
                setError('');
              }}
            >
              <div className="reservation-card__image">
                <img src={item.image} alt="" />
              </div>
              <div className="reservation-card__rule" />
              <div className="reservation-card__title">
                <h2>{item.name}</h2>
                {item.trainingRequired ? (
                  <span>
                    <ShieldAlert aria-hidden="true" /> Training required
                  </span>
                ) : null}
              </div>
              <div className="reservation-card__meta">
                <span>{item.type}</span>
                <strong>{rateLabel(item.rate)}</strong>
              </div>
              <small>{item.availability}</small>
            </button>
          ))}
        </div>
        {!catalog.loading && !catalog.error && !equipment.length ? (
          <p className="empty-state">No equipment matches this filter.</p>
        ) : null}
      </section>
      <div className="dashboard-divider" />
      <section
        className="reservation-section"
        aria-labelledby="my-reservations"
      >
        <div className="reservation-section__heading">
          <div>
            <p className="eyebrow">Your saved bookings</p>
            <h2 id="my-reservations" tabIndex={-1}>My reservations</h2>
          </div>
          <button className="button button--quiet" onClick={bookings.reload}>
            Refresh
          </button>
        </div>
        <p>
          No payment is taken when you book. Cancel at least 24 hours ahead; bookings on the same machine need 15 minutes between them.
        </p>
        {bookings.loading ? <p role="status">Loading reservations…</p> : null}
        {bookings.error ? (
          <p role="alert" className="form-error">
            {bookings.error} <button onClick={bookings.reload}>Retry</button>
          </p>
        ) : null}
        {!bookings.loading && !bookings.error && !bookings.data?.length ? (
          <p className="empty-state">
            No reservations yet. Choose equipment above to get started.
          </p>
        ) : null}
        <div className="saved-records">
          {bookings.data?.map((item) => (
            <article className="panel saved-record" key={item.id}>
              <div>
                <h3>{item.equipmentName}</h3>
                <p>
                  {dateTime(item.startTime)} –{' '}
                  {dateTime(item.endTime)}
                </p>
                <span>
                  {item.location} · {item.status}
                </span>
              </div>
              {['pending', 'confirmed'].includes(item.status) &&
              new Date(item.startTime).getTime() >= Date.now()+24*60*60*1000 ? (
                <button
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => void cancel(item.id)}
                >
                  Cancel reservation
                </button>
              ) : ['pending', 'confirmed'].includes(item.status) ? (
                <p className="form-caption">{new Date(item.startTime).getTime() > Date.now()
                  ? 'Online cancellation closes 24 hours before the start time.'
                  : 'This reservation has started; online cancellation is closed.'}</p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <Modal
        open={!!selected}
        title={selected ? 'Reserve ' + selected.name : 'Reserve equipment'}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        {selected ? (
          <form className="reservation-form equipment-reservation-form" onSubmit={reserve} onChange={() => setError('')}>
            <div className="reservation-form__summary">
              <img src={selected.image} alt="" />
              <div>
                <p className="eyebrow">{selected.type}</p>
                <h3>{selected.name}</h3>
                <span>{rateLabel(selected.rate)}</span>
              </div>
            </div>
            {canBookForOthers&&<label className="form-field">
              <span>Book for member ID (optional)</span>
              <input name="memberId" type="number" min="1" step="1" placeholder="Leave blank to book for yourself" />
              <small>Use the member ID from User management. Their membership, training and waivers will be checked. The booking appears in their account.</small>
            </label>}
            <label className="form-field">
              <span>Start date and time ({zone})</span>
              <input name="start" type="datetime-local" required />
            </label>
            <label className="form-field">
              <span>Duration</span>
              <select name="duration" defaultValue="1">
                {Array.from({length:24},(_,i)=><option key={i+1} value={i+1}>{i+1} {i===0?'hour':'hours'}</option>)}
              </select>
            </label>
            {!selected.canReserve && !canBookForOthers ? (
              <p className="form-notice">
                {selected.availability}.{' '}
                <Link to="/certifications">
                  Review your waivers and certifications
                </Link>
                .
              </p>
            ) : null}
            <p className="form-caption">
              Cancel at least 24 hours before the start time. Leave 15 minutes between bookings for the same machine.
              {' '}The booking member’s access and this time slot are checked when you book. No
              payment will be collected.
            </p>
            {error ? (
              <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <button
              className="button button--primary button--wide"
              type="submit"
              disabled={busy || selected.status !== 'available'}
            >
              <CalendarDays aria-hidden="true" />{' '}
              {busy ? 'Saving…' : 'Confirm reservation'}
            </button>
          </form>
        ) : null}
      </Modal>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
function rateLabel(rate: number | null) {
  return rate === null ? 'Rate not set' : '$' + rate.toFixed(2) + '/hour';
}
