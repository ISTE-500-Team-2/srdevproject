import { Building2, CalendarDays, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import type {
  LiveEquipment,
  LiveStudio,
  Reservation,
  StudioAvailability,
  StudioLease,
} from '../lib/contracts';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function todayDate() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function formatMoney(amount: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}
function formatLeaseEnd(exclusiveEnd: string) {
  const date = new Date(`${exclusiveEnd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return formatDate(date.toISOString().slice(0, 10));
}

export function ReservationsPage() {
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const bookings = useApi<Reservation[]>('/reservations');
  const studios = useApi<LiveStudio[]>('/studios');
  const studioLeases = useApi<StudioLease[]>('/studio-leases');
  const [filter, setFilter] = useState('all');
  const [studioFilter, setStudioFilter] = useState('all');
  const [selected, setSelected] = useState<LiveEquipment | null>(null);
  const [selectedStudio, setSelectedStudio] = useState<LiveStudio | null>(null);
  const [studioStartDate, setStudioStartDate] = useState(tomorrowDate);
  const [studioMonths, setStudioMonths] = useState('1');
  const [studioAvailable, setStudioAvailable] = useState<boolean | null>(null);
  const [checkingStudio, setCheckingStudio] = useState(false);
  const [studioError, setStudioError] = useState('');
  const [studioBusy, setStudioBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const equipment = (catalog.data ?? []).filter(
    (item) =>
      filter === 'all' ||
      (filter === 'ready' ? item.canReserve : item.trainingRequired),
  );
  const studioList = (studios.data ?? []).filter((studio) => {
    if (studioFilter === 'available') return studio.availableNow;
    if (studioFilter === 'all') return true;
    return studio.size.toLowerCase() === studioFilter;
  });

  useEffect(() => {
    if (!selectedStudio || !studioStartDate || !/^\d+$/.test(studioMonths) || Number(studioMonths) < 1) {
      setStudioAvailable(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setCheckingStudio(true);
    setStudioAvailable(null);
    const query = new URLSearchParams({ startDate: studioStartDate, months: studioMonths });
    api<{ studios: StudioAvailability[] }>(`/studios/availability?${query}`, { signal: controller.signal })
      .then((result) => {
        if (active) setStudioAvailable(result.studios.find((item) => item.id === selectedStudio.id)?.available ?? false);
      })
      .catch(() => { if (active) setStudioAvailable(null); })
      .finally(() => { if (active) setCheckingStudio(false); });
    return () => { active = false; controller.abort(); };
  }, [selectedStudio, studioStartDate, studioMonths]);

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
  const reserveStudio = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStudio) return;
    setStudioBusy(true);
    setStudioError('');
    try {
      const lease = await api<StudioLease>('/studio-leases', {
        method: 'POST',
        body: { studioId: selectedStudio.id, startDate: studioStartDate, months: Number(studioMonths) },
      });
      setToast(`Studio lease confirmed for ${lease.studioName}.`);
      setSelectedStudio(null);
      studioLeases.reload();
      studios.reload();
    } catch (err) {
      setStudioError(errorMessage(err));
    } finally {
      setStudioBusy(false);
    }
  };
  const cancelStudioLease = async (id: number) => {
    setStudioBusy(true);
    setStudioError('');
    try {
      await api(`/studio-leases/${id}/cancel`, { method: 'POST' });
      studioLeases.reload();
      studios.reload();
      setToast('Studio lease cancelled.');
    } catch (err) {
      setStudioError(errorMessage(err));
    } finally {
      setStudioBusy(false);
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
      <section className="reservation-section" aria-labelledby="studio-spaces">
        <div className="reservation-section__heading">
          <div>
            <p className="eyebrow">Private maker spaces · monthly leases</p>
            <h2 id="studio-spaces">Studio Spaces</h2>
          </div>
          <label className="select-control">
            <Filter aria-hidden="true" />
            <span>Filter studios</span>
            <select value={studioFilter} onChange={(event) => setStudioFilter(event.target.value)}>
              <option value="all">All studios</option>
              <option value="available">Available today</option>
              <option value="large">Large</option>
              <option value="medium">Medium</option>
              <option value="small">Small</option>
            </select>
          </label>
        </div>
        <p className="studio-section__caption">Choose a room and lease term to check availability. Rent is arranged with staff; no payment is collected here.</p>
        {studios.loading ? <p role="status">Loading studio spaces…</p> : null}
        {studios.error ? (
          <p role="alert" className="form-error">
            {studios.error} <button onClick={studios.reload}>Retry</button>
          </p>
        ) : null}
        <div className="studio-grid">
          {studioList.map((studio) => (
            <button
              className="reservation-card studio-card"
              key={studio.id}
              aria-label={`Lease ${studio.name}, ${studio.size}, ${formatMoney(studio.monthlyRate)} per month`}
              onClick={() => {
                setSelectedStudio(studio);
                setStudioStartDate(tomorrowDate());
                setStudioMonths('1');
                setStudioAvailable(null);
                setStudioError('');
              }}
            >
              <div className="studio-card__image">
                <img src={studio.image} alt={`Inside the ${studio.name} studio`} />
              </div>
              <div className="reservation-card__rule" />
              <div className="reservation-card__title">
                <h3>{studio.name}</h3>
                <span>{studio.size}</span>
              </div>
              <div className="reservation-card__meta">
                <span>{studio.description}</span>
                <strong>{formatMoney(studio.monthlyRate)}/month</strong>
              </div>
              <small>{studio.availableNow ? 'Available today' : 'Currently leased · check future dates'}</small>
            </button>
          ))}
        </div>
        {!studios.loading && !studios.error && !studioList.length ? (
          <p className="empty-state">No studio spaces match this filter.</p>
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
      <section className="reservation-section" aria-labelledby="my-studio-leases">
        <div className="reservation-section__heading">
          <div>
            <p className="eyebrow">Your studio bookings</p>
            <h2 id="my-studio-leases">My studio leases</h2>
          </div>
          <button className="button button--quiet" onClick={studioLeases.reload}>Refresh</button>
        </div>
        {studioLeases.loading ? <p role="status">Loading studio leases…</p> : null}
        {studioLeases.error ? (
          <p role="alert" className="form-error">
            {studioLeases.error} <button onClick={studioLeases.reload}>Retry</button>
          </p>
        ) : null}
        {studioError && !selectedStudio ? <p role="alert" className="form-error">{studioError}</p> : null}
        {!studioLeases.loading && !studioLeases.error && !studioLeases.data?.length ? (
          <p className="empty-state">No studio leases yet. Choose a studio above to check dates.</p>
        ) : null}
        <div className="saved-records">
          {studioLeases.data?.map((lease) => (
            <article className="panel saved-record" key={lease.id}>
              <div>
                <h3>{lease.studioName}</h3>
                <p>{formatDate(lease.startDate)} – {formatLeaseEnd(lease.endDate)} · {lease.months} {lease.months === 1 ? 'month' : 'months'}</p>
                <span>{formatMoney(lease.monthlyRate)}/month · {lease.status}</span>
              </div>
              {lease.status === 'confirmed' && lease.startDate > todayDate() ? (
                <button className="button button--quiet" disabled={studioBusy} onClick={() => void cancelStudioLease(lease.id)}>
                  Cancel lease
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <Modal
        open={!!selectedStudio}
        title={selectedStudio ? `Lease ${selectedStudio.name}` : 'Lease a studio'}
        onClose={() => { if (!studioBusy) setSelectedStudio(null); }}
      >
        {selectedStudio ? (
          <form className="reservation-form" onSubmit={reserveStudio}>
            <div className="reservation-form__summary">
              <img src={selectedStudio.image} alt="" />
              <div>
                <p className="eyebrow">{selectedStudio.size} studio</p>
                <h3>{selectedStudio.name}</h3>
                <span>{formatMoney(selectedStudio.monthlyRate)}/month</span>
              </div>
            </div>
            <p>{selectedStudio.description}</p>
            <label className="form-field">
              <span>Lease start date</span>
              <input type="date" required min={tomorrowDate()} value={studioStartDate} onChange={(event) => setStudioStartDate(event.target.value)} />
            </label>
            <label className="form-field">
              <span>Lease term (whole months)</span>
              <input type="number" required min="1" step="1" value={studioMonths} onChange={(event) => setStudioMonths(event.target.value)} />
            </label>
            <p className="studio-total"><span>Estimated rent · {studioMonths || 0} {Number(studioMonths) === 1 ? 'month' : 'months'}</span><strong>{formatMoney(selectedStudio.monthlyRate * (Number(studioMonths) || 0))}</strong></p>
            <p className="form-notice" role="status">
              {checkingStudio ? 'Checking availability…' : studioAvailable === true ? 'Available for the selected dates.' : studioAvailable === false ? 'Unavailable for part of the selected dates. Try another date or term.' : 'Select a future date and term to check availability.'}
            </p>
            <p className="form-caption">An active membership covering the full lease term is required. Your lease confirms immediately; rent is arranged with staff and is not collected online.</p>
            {studioError ? <p role="alert" className="form-error">{studioError}</p> : null}
            <button className="button button--primary button--wide" type="submit" disabled={studioBusy || checkingStudio || studioAvailable !== true}>
              <Building2 aria-hidden="true" /> {studioBusy ? 'Saving…' : 'Confirm studio lease'}
            </button>
          </form>
        ) : null}
      </Modal>
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
