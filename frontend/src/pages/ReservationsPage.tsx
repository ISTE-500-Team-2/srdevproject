import { CalendarDays, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import type { LiveEquipment, Reservation } from '../lib/contracts';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';

export function ReservationsPage() {
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const bookings = useApi<Reservation[]>('/reservations');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<LiveEquipment | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const equipment = (catalog.data ?? []).filter(
    (item) =>
      filter === 'all' ||
      (filter === 'ready' ? item.canReserve : item.trainingRequired),
  );
  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const input = reservationInput(
        selected.id,
        String(form.get('start')),
        Number(form.get('duration')),
      );
      await api<Reservation>('/reservations', { method: 'POST', body: input });
      setToast('Reservation saved for ' + selected.name + '.');
      setSelected(null);
      bookings.reload();
      catalog.reload();
    } catch (err) {
      setError(err instanceof RangeError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: number) => {
    setBusy(true);
    setError('');
    try {
      await api('/reservations/' + id + '/cancel', { method: 'POST' });
      bookings.reload();
      setToast('Reservation cancelled.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="reservations-page page-enter">
      <section className="reservation-section">
        <div className="reservation-section__heading">
          <div>
            <p className="eyebrow">Reserve by the hour</p>
            <h1>Equipment</h1>
          </div>
          <label className="select-control">
            <Filter aria-hidden="true" />
            <span>Filter</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All equipment</option>
              <option value="ready">Eligible now</option>
              <option value="training">Training required</option>
            </select>
          </label>
        </div>
        {catalog.loading ? <p role="status">Loading equipment…</p> : null}
        {catalog.error ? (
          <p role="alert" className="form-error">
            {catalog.error} <button onClick={catalog.reload}>Retry</button>
          </p>
        ) : null}
        {!selected && error ? (
          <p role="alert" className="form-error">
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
            <h2 id="my-reservations">My reservations</h2>
          </div>
          <button className="button button--quiet" onClick={bookings.reload}>
            Refresh
          </button>
        </div>
        <p>
          Times shown in {zone}. Reservations are saved to your account; no
          payment is collected.
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
                  {new Date(item.startTime).toLocaleString()} –{' '}
                  {new Date(item.endTime).toLocaleString()}
                </p>
                <span>
                  {item.location} · {item.status}
                </span>
              </div>
              {['pending', 'confirmed'].includes(item.status) &&
              new Date(item.startTime).getTime() > Date.now() ? (
                <button
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => void cancel(item.id)}
                >
                  Cancel reservation
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <section className="panel feature-notice">
        <h2>Studio spaces</h2>
        <p>Studio leasing is not available in this version.</p>
      </section>
      <Modal
        open={!!selected}
        title={selected ? 'Reserve ' + selected.name : 'Reserve equipment'}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        {selected ? (
          <form className="reservation-form" onSubmit={reserve}>
            <div className="reservation-form__summary">
              <img src={selected.image} alt="" />
              <div>
                <p className="eyebrow">{selected.type}</p>
                <h3>{selected.name}</h3>
                <span>{rateLabel(selected.rate)}</span>
              </div>
            </div>
            <label className="form-field">
              <span>Start date and time ({zone})</span>
              <input name="start" type="datetime-local" required />
            </label>
            <label className="form-field">
              <span>Duration</span>
              <select name="duration" defaultValue="1">
                <option value="1">1 hour</option>
                <option value="2">2 hours</option>
                <option value="3">3 hours</option>
                <option value="5">5 hours</option>
              </select>
            </label>
            {!selected.canReserve ? (
              <p className="form-notice">
                {selected.availability}.{' '}
                <Link to="/certifications">
                  Review your waivers and certifications
                </Link>
                .
              </p>
            ) : null}
            <p className="form-caption">
              Your access and this time slot are checked when you book. No
              payment will be collected.
            </p>
            {error ? (
              <p role="alert" className="form-error">
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
