import { useAuth } from '../context/AuthContext';
import { CalendarDays, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import type { LiveEquipment, Reservation } from '../lib/contracts';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';
import type { Studio } from '../lib/studioContracts';
import { dateOnly, nextMonth, policy } from '../lib/studioDisplay';

export function ReservationsPage() {
  const {user}=useAuth();
  const canBookForOthers=!!user?.roles.some(r=>['staff','admin'].includes(r)) && !user.roles.includes('instructor');
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const bookings = useApi<Reservation[]>('/reservations');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<LiveEquipment | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const studios = useApi<{ studios: Studio[]; cardTestEnabled: boolean; timeZone: string }>('/studios');
  const [studioFilter, setStudioFilter] = useState('all');
  const [selectedStudio, setSelectedStudio] = useState<Studio | null>(null);
  const [studioStart, setStudioStart] = useState('');
  const [studioMethod, setStudioMethod] = useState('manual');
  const [studioRequestKey, setStudioRequestKey] = useState(() => crypto.randomUUID());
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const equipment = (catalog.data ?? []).filter(
    (item) =>
      filter === 'all' ||
      (filter === 'ready' ? item.canReserve : item.trainingRequired),
  );

  const studioZone = studios.data?.timeZone ?? zone;
  const studioToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: studioZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const studioEnd = nextMonth(studioStart);
  const canBookStudio =
    user?.membership === 'Monthly' && !user?.roles.includes('instructor');
  const studioSizes = [...new Set((studios.data?.studios ?? []).map((item) => item.size))];
  const studioList = (studios.data?.studios ?? []).filter(
    (item) => studioFilter === 'all' || item.size === studioFilter,
  );
  const studioConflict =
    !!selectedStudio &&
    !!studioStart &&
    selectedStudio.availability.some(
      (r) => dateOnly(r.starts_on) < studioEnd && dateOnly(r.ends_on) > studioStart,
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
      const target=String(form.get('memberId')??'').trim();
      const result=await api<Reservation>('/reservations', { method: 'POST', body: {...input,...(canBookForOthers&&target?{userId:Number(target)}:{})} });
      setToast('Reservation saved for ' + selected.name + (result.userId!==user?.id?' for member #'+result.userId:'') + '.');
      setSelected(null);
      bookings.reload();
      catalog.reload();
    } catch (err) {
      setError(err instanceof RangeError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reserveStudio = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStudio) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ hold_until: string; checkoutUrl?: string }>('/studio-rentals', {
        method: 'POST',
        body: {
          studioId: selectedStudio.id,
          startDate: studioStart,
          paymentMethod: studioMethod,
          requestKey: studioRequestKey,
          expectedRevision: selectedStudio.revision,
        },
      });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      setToast(
        selectedStudio.name + ' held until ' + new Date(result.hold_until).toLocaleTimeString() +
          '. Pay with staff before then; your booking is not confirmed yet.',
      );
      setSelectedStudio(null);
      setStudioRequestKey(crypto.randomUUID());
      studios.reload();
    } catch (err) {
      setError(errorMessage(err));
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
        {!selected && !selectedStudio && error ? (
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
      <p className="eyebrow">Reserve by the month</p>
      <h1 id="studio-spaces">Studio Spaces</h1>
    </div>
    <label className="select-control">
      <Filter aria-hidden="true" />
      <span>Filter</span>
      <select
        value={studioFilter}
        onChange={(event) => setStudioFilter(event.target.value)}
      >
        <option value="all">All sizes</option>
        {studioSizes.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </label>
  </div>
  {studios.loading ? <p role="status">Loading studio spaces…</p> : null}
  {studios.error ? (
    <p role="alert" className="form-error">
      {studios.error} <button onClick={studios.reload}>Retry</button>
    </p>
  ) : null}
  <div className="studio-grid">
    {studioList.map((item) => (
      <button
        className="reservation-card studio-card"
        key={item.id}
        onClick={() => {
          setSelectedStudio(item);
          setStudioStart('');
          setStudioRequestKey(crypto.randomUUID());
          setError('');
        }}
      >
        <div className="reservation-card__image studio-card__image">
          <img src={studioImage(item.name)} alt="" />
        </div>
        <div className="reservation-card__rule" />
        <div className="reservation-card__title">
          <h2>{item.name}</h2>
          <span>{item.size}</span>
        </div>
        <div className="reservation-card__meta">
          <span>A {item.size.toLowerCase()} sized maker studio</span>
          <strong>{studioRateLabel(item.monthly_cents)}</strong>
        </div>
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
          payment is collected. Equipment cancellation requires at least 24 hours notice; memberships do not replace reservations.
          {' '}Equipment bookings require at least 15 minutes between users of the same machine.
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
              new Date(item.startTime).getTime() >= Date.now()+24*60*60*1000 ? (
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
              The booking member’s access and this time slot are checked when you book. No
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
      <Modal
  open={!!selectedStudio}
  title={selectedStudio ? 'Reserve ' + selectedStudio.name : 'Reserve studio'}
  onClose={() => {
    if (!busy) setSelectedStudio(null);
  }}
>
  {selectedStudio ? (
    <form className="reservation-form" onSubmit={reserveStudio}>
      <div className="reservation-form__summary">
        <img src={studioImage(selectedStudio.name)} alt="" />
        <div>
          <p className="eyebrow">{selectedStudio.size}</p>
          <h3>{selectedStudio.name}</h3>
          <span>{studioRateLabel(selectedStudio.monthly_cents)}</span>
        </div>
      </div>
      <label className="form-field">
        <span>Rental start date ({studioZone})</span>
        <input
          type="date"
          min={studioToday}
          value={studioStart}
          required
          onChange={(event) => {
            setStudioStart(event.target.value);
            setStudioRequestKey(crypto.randomUUID());
          }}
        />
      </label>
      <label className="form-field">
        <span>Payment method</span>
        <select
          value={studioMethod}
          onChange={(event) => {
            setStudioMethod(event.target.value);
            setStudioRequestKey(crypto.randomUUID());
          }}
        >
          <option value="manual">Pay with staff</option>
          {studios.data?.cardTestEnabled ? (
            <option value="stripe_test">
              Card checkout — TEST MODE, no real charges
            </option>
          ) : null}
        </select>
      </label>
      {studioEnd ? (
        <p className="form-caption">
          Rental period: <strong>{studioStart} through {studioEnd}</strong> (end date exclusive).
        </p>
      ) : null}
      {studioStart ? (
        <p className="form-notice">
          {studioConflict
            ? 'Unavailable for the selected month.'
            : 'Available for the selected month.'}
        </p>
      ) : null}
      {!canBookStudio ? (
        <p className="form-notice">
          An active monthly subscription is required. Instructor accounts
          cannot create reservations.
        </p>
      ) : null}
      <p className="form-caption">{policy(selectedStudio.cancellation_policy)}</p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <button
        className="button button--primary button--wide"
        type="submit"
        disabled={
          busy ||
          !canBookStudio ||
          !studioStart ||
          studioConflict ||
          !selectedStudio.policy_confirmed ||
          !selectedStudio.monthly_cents
        }
      >
        <CalendarDays aria-hidden="true" />{' '}
        {busy
          ? 'Saving…'
          : studioMethod === 'manual'
            ? 'Hold and pay with staff'
            : 'Continue to test card checkout'}
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

function studioRateLabel(cents: number | null) {
  return cents === null ? 'Rate not set' : '$' + (cents / 100).toFixed(2) + '/month';
}
function studioImage(name: string) {
  return '/assets/space-' + name.toLowerCase() + '.webp';
}