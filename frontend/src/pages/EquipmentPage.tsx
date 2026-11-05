import { useAuth } from '../context/AuthContext';
import { CalendarDays, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { MemberSelect } from '../components/MemberSelect';
import { StartTimePicker } from '../components/StartTimePicker';
import { Toast } from '../components/Toast';
import { api, ApiError, errorMessage } from '../lib/api';
import type { LiveEquipment, Reservation } from '../lib/contracts';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';
import { dateTime } from "../lib/display";

export function EquipmentPage() {
  const {user}=useAuth();
  const [params] = useSearchParams();
  const attempt = useRef<{signature: string; key: string} | null>(null);
  const canBookForOthers=!!user?.roles.some(r=>['staff','admin'].includes(r)) && !user.roles.includes('instructor');
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const bookings = useApi<Reservation[]>('/reservations', {retainOnReload: true});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const mutationInFlight = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [selectedGroup, setSelectedGroup] = useState<{type: string; machines: LiveEquipment[]} | null>(null);
  const [selected, setSelected] = useState<LiveEquipment | null>(null);
  useEffect(() => {
    if (!selected) return;
    const reload = () => catalog.reload();
    const timer = window.setInterval(reload, 15000);
    window.addEventListener('focus', reload);
    reload();
    return () => { window.clearInterval(timer); window.removeEventListener('focus', reload); };
  }, [selected?.id]);
  const liveSelected = catalog.data?.find(item => item.id === selected?.id) ?? selected;
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const [busy, setBusy] = useState(false);
  const [duration, setDuration] = useState(1);
  const totalCents = liveSelected?.rate == null ? null : Math.round(liveSelected.rate * 100) * duration;
  const returnId = Number(params.get('reservation'));
  const returnedBooking = bookings.data?.find(item => item.id === returnId);
  const bookingBlockReason = (item: Reservation) => {
    const machine = catalog.data?.find(equipment => equipment.id === item.equipmentId);
    return item.userId === user?.id && machine?.canReserve === false ? machine.availability : '';
  };
  useEffect(() => {
    if (!bookings.data?.some(item => item.paymentStatus === 'pending')) return;
    const timer = window.setInterval(bookings.reload, 5000);
    return () => window.clearInterval(timer);
  }, [bookings.data]);
  const equipment = (catalog.data ?? []).filter(
    (item) =>
      (filter === 'all' ||
      (filter === 'ready' ? item.canReserve : item.trainingRequired)) &&
      `${item.name} ${item.type}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || mutationInFlight.current) return;
    if (!canBookForOthers && !liveSelected?.canReserve) {
      setError(liveSelected?.availability || 'Complete the required waivers and certifications before reserving this machine.');
      return;
    }
    if (!new FormData(event.currentTarget).get('start')) { setError('Choose an available date and time.'); return; }
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
      const details = {...input, amountCents: totalCents, ...(canBookForOthers&&target?{userId:Number(target)}:{})};
      const signature = JSON.stringify(details);
      if (attempt.current?.signature !== signature) attempt.current = {signature, key: crypto.randomUUID()};
      const result = await api<Reservation>('/reservations', { method: 'POST', body: {...details, requestKey: attempt.current.key} });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (result.status !== 'confirmed') throw new ApiError(409, 'PAYMENT_PENDING', 'Payment is required before this reservation is confirmed. Refresh your reservations to continue checkout.');
      attempt.current = null;
      setToast('Reservation confirmed for ' + selected.name + (result.userId!==user?.id?' for member #'+result.userId:'') + '.');
      setSelected(null);
      bookings.reload();
      catalog.reload();
    } catch (err) {
      if (err instanceof ApiError && ['CHECKOUT_EXPIRED', 'KEY_REUSED'].includes(err.code)) attempt.current = null;
      catalog.reload();
      bookings.reload();
      setError(err instanceof RangeError ? err.message :
        err instanceof ApiError && err.code === 'RESERVATION_CONFLICT'
          ? 'This equipment is already reserved during your selected time. Choose another start time or shorten the duration, then try again.'
          : errorMessage(err));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const checkoutAction = async (id: number, cancelPayment = false) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true); setError(''); setToast(null);
    try {
      const result = await api<Reservation>(`/reservations/${id}/${cancelPayment ? 'cancel-checkout' : 'checkout'}`, {method: 'POST'});
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else { bookings.reload(); catalog.reload(); }
    } catch (err) { setError(errorMessage(err)); bookings.reload(); catalog.reload(); }
    finally { mutationInFlight.current = false; setBusy(false); }
  };
  const cancel = async (id: number) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setToast(null);
    setError('');
    try {
      const item = bookings.data?.find(booking => booking.id === id);
      await api((canBookForOthers && item?.userId !== user?.id ? '/admin' : '') + '/reservations/' + id + '/cancel', { method: 'POST' });
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
          {groupEquipment(equipment).map(([type, machines]) => (
            <button className="reservation-card equipment-card" key={type}
              onClick={() => {
                setSelectedGroup({type, machines});
                setSelected(machines[0]!);
                setToast(null);
                setError('');
              }}>
              <div className="reservation-card__image"><img src={machines[0]!.image} alt="" /></div>
              <div className="reservation-card__rule" />
              <div className="reservation-card__title"><h2>{type}</h2></div>
              <p className="equipment-card__names">{machines.map(item => item.name).join(' \u00b7 ')}</p>
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
          Pay the hourly rate × your selected hours through Stripe to confirm your reservation. Cancel at least 24 hours ahead; bookings on the same machine need 15 minutes between them. Contact staff about refunds.
        </p>
        {params.get('payment') === 'returned' && <p role="status" className="form-notice">
          {returnedBooking?.status === 'confirmed' && returnedBooking.paymentStatus === 'paid'
            ? 'Payment received. Your reservation is confirmed.'
            : returnedBooking?.paymentStatus === 'expired' ? 'Checkout expired without payment. Choose a time to try again.'
            : 'Checking your payment. Your reservation is confirmed only after payment is verified.'}
        </p>}
        {params.get('payment') === 'cancelled' && <p role="status" className="form-notice">
          Checkout was closed. Payment is still required to confirm your reservation. Resume payment or cancel the checkout below.
        </p>}
        {error && !selected && <p role="alert" className="form-error">{error}</p>}
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
                  {item.location} · {item.paymentStatus === 'pending' ? bookingBlockReason(item) ? 'Requirements need attention' : 'Awaiting payment' : item.status}
                </span>
              </div>
              {item.amountCents != null && <p>{money(item.amountCents)} · {item.paymentStatus === 'paid' ? 'Paid' : item.paymentStatus === 'expired' ? 'Checkout expired' : 'Payment required'}</p>}
              {item.paymentStatus === 'pending' && item.payerId === user?.id ? <div>
                {bookingBlockReason(item) && <p className="form-notice">{bookingBlockReason(item)}.{' '}
                  <Link to="/certifications">Review your waivers and certifications</Link> before continuing.</p>}
                {item.holdUntil && <p>Complete payment by {dateTime(item.holdUntil)} to confirm this booking.</p>}
                <button className="button button--primary" disabled={busy || !!bookingBlockReason(item)} onClick={() => void checkoutAction(item.id)}>Pay {money(item.amountCents ?? 0)}</button>
                <button className="button button--quiet" disabled={busy} onClick={() => void checkoutAction(item.id, true)}>Cancel checkout</button>
              </div> : item.paymentStatus === 'pending' ? <p>Awaiting payment from the person who started checkout.</p> : ['pending', 'confirmed'].includes(item.status) &&
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
        title={selectedGroup ? 'Reserve ' + selectedGroup.type : 'Reserve equipment'}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        {selected ? (
          <form className="reservation-form equipment-reservation-form" onSubmit={reserve} onChange={() => setError('')}>
            {canBookForOthers&&<div className="form-field">
              <MemberSelect name="memberId" label="Book for a member (optional)" required={false} />
              <small>Leave empty to book for yourself. Their membership, training and waivers are checked, and the booking appears in their account.</small>
            </div>}
            <div className="equipment-booking-layout">
            <section aria-labelledby="equipment-time-heading">
              <h3 className="equipment-booking-step" id="equipment-time-heading"><span>1</span> Start date</h3>
            <StartTimePicker calendar occupied={liveSelected?.occupied} unavailable={liveSelected?.status !== 'available'} name="start" hours={duration} onPick={() => setError('')}>
              <label className="form-field">
                <span>Duration</span>
                <select name="duration" value={duration} onChange={e=>setDuration(Number(e.target.value))}>
                  {Array.from({length:24},(_,i)=><option key={i+1} value={i+1}>{i+1} {i===0?'hour':'hours'}</option>)}
                </select>
              </label>
            </StartTimePicker>
            </section>
            <fieldset className="equipment-machine-picker" disabled={busy}>
              <legend className="equipment-booking-step"><span>2</span> Machine</legend>
              {selectedGroup?.machines.map(item => (
                <label className="equipment-machine-choice" key={item.id}>
                  <input type="radio" name="equipmentId" value={item.id} checked={selected.id === item.id}
                    onChange={() => { setSelected(item); setError(''); }} />
                  <span><strong>{item.name}</strong><span>{rateLabel(item.rate)}</span>
                    {item.type.toLowerCase() !== selectedGroup.type.toLowerCase() && <span>{item.type}</span>}
                    {item.trainingRequired && <span className="equipment-machine-training"><ShieldAlert aria-hidden="true" />Training required</span>}
                    {item.availability !== 'Choose a time to check availability' && <small>{item.availability}</small>}
                  </span>
                </label>
              ))}
            </fieldset>
            </div>
            {!liveSelected?.canReserve && !canBookForOthers ? (
              <p className="form-notice">
                {liveSelected?.availability}.{' '}
                <Link to="/certifications">
                  Review your waivers and certifications
                </Link>
                .
              </p>
            ) : null}
            <p className="form-caption">
              Cancel at least 24 hours before the start time. Leave 15 minutes between bookings for the same machine.
              {' '}The booking member’s access and this time slot are checked when you book. Payment is required before confirmation. Contact staff about refunds.
            </p>
            <div className="form-notice" aria-live="polite">
              {totalCents === null ? 'Rate not set. Contact staff before reserving.' : <>
                <strong>Total: {money(totalCents)}</strong><br />
                {money(Math.round((liveSelected?.rate ?? 0) * 100))}/hour × {duration} {duration === 1 ? 'hour' : 'hours'}
                <p>{totalCents > 0 ? 'Continue to Stripe to pay. Your reservation is confirmed after payment succeeds. You have 31 minutes to complete checkout.' : 'No payment is required for this equipment.'}</p>
              </>}
            </div>
            {error ? (
              <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <button
              className="button button--primary equipment-booking-submit"
              type="submit"
              disabled={busy || liveSelected?.status !== 'available' || totalCents === null || (!canBookForOthers && !liveSelected?.canReserve)}
            >
              <CalendarDays aria-hidden="true" />{' '}
              {busy ? 'Preparing checkout…' : totalCents ? `Pay ${money(totalCents)} & confirm reservation` : 'Confirm reservation'}
            </button>
          </form>
        ) : null}
      </Modal>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
function money(cents: number) { return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100); }
function rateLabel(rate: number | null) {
  return rate === null ? 'Rate not set' : '$' + rate.toFixed(2) + '/hour';
}

// Group presentation only; booking always retains the original machine record.
function groupEquipment(equipment: LiveEquipment[]): [string, LiveEquipment[]][] {
  const groups = new Map<string, LiveEquipment[]>();
  for (const item of equipment) {
    const category = item.type.trim();
    const type = /^3d[ -]*(print|printing|printer)$/i.test(category) ? '3D Printer'
      : /\bcnc\b/i.test(category) ? 'CNC Machine'
      : /\blathe\b/i.test(category) ? 'Lathe'
      : /^laser( engraver)?$/i.test(category) ? 'Laser Engraver'
      : category || 'Other equipment';
    groups.set(type, [...(groups.get(type) ?? []), item]);
  }
  const order = ['3D Printer', 'Laser Engraver', 'Lathe', 'CNC Machine'];
  return [...groups].sort(([a], [b]) => {
    const rank = (type: string) => order.includes(type) ? order.indexOf(type) : order.length;
    return rank(a) - rank(b);
  });
}
