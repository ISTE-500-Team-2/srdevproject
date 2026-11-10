import { useAuth } from '../context/AuthContext';
import { CalendarDays, ChevronDown, Filter, ShieldAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Skeleton, SkeletonGroup } from '../components/Skeleton';
import { MemberSelect } from '../components/MemberSelect';
import { StartTimePicker } from '../components/StartTimePicker';
import { Toast } from '../components/Toast';
import { api, ApiError, errorMessage } from '../lib/api';
import type { EquipmentPrice, LiveEquipment, Reservation } from '../lib/contracts';
import { EquipmentPriceBreakdown } from '../components/EquipmentPriceBreakdown';
import { useApi } from '../lib/useApi';
import { reservationInput } from '../lib/reservationInput';
import { cents, dateTime, shortDate, timeOnly } from "../lib/display";

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
  const quote = useApi<EquipmentPrice | null>(liveSelected ? `/equipment/${liveSelected.id}/quote?hours=${duration}` : null);
  const totalCents = quote.data?.totalCents ?? null;
  const returnId = Number(params.get('reservation'));
  const returnedBooking = bookings.data?.find(item => item.id === returnId);
  const bookingBlockReason = (item: Reservation) => {
    const machine = catalog.data?.find(equipment => equipment.id === item.equipmentId);
    return item.userId === user?.id && machine?.canReserve === false ? machine.availability : '';
  };
  const [pastOpen, setPastOpen] = useState(true);
  const [showCancelled, setShowCancelled] = useState(false);
  const now = Date.now();
  const sortedBookings = splitBookings(bookings.data ?? [], now, user?.id);
  const machineFor = (item: Reservation) =>
    item.equipmentId == null ? undefined : catalog.data?.find(equipment => equipment.id === item.equipmentId);
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
      if (!quote.data) throw new ApiError(409, 'PRICE_NOT_CONFIGURED', 'Refresh the equipment price before reserving.');
      const details = {...input, amountCents: totalCents, expectedPrice: quote.data, ...(canBookForOthers&&target?{userId:Number(target)}:{})};
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
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') quote.reload();
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
        {catalog.loading ? <EquipmentTilesLoading /> : <div className="equipment-grid">
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
        </div>}
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
        {bookings.loading ? <BookingsLoading /> : null}
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
        {sortedBookings.upcoming.length || sortedBookings.past.length || sortedBookings.cancelled.length ? <>
          <div className="booking-group">
            <h3>Upcoming · {sortedBookings.upcoming.length}</h3>
          </div>
          {sortedBookings.upcoming.length ? (
            <div className="booking-list">
              {sortedBookings.upcoming.map(item => {
                const view = describeBooking(item, now, user?.id, bookingBlockReason(item));
                return (
                  <BookingRow key={item.id} item={item} view={view} machine={machineFor(item)} userId={user?.id} now={now} card>
                    {view.action === 'pay' ? <>
                      <button className="button button--quiet" disabled={busy} onClick={() => void checkoutAction(item.id, true)}>Cancel checkout</button>
                      <button className="button button--primary" disabled={busy || !!bookingBlockReason(item)} onClick={() => void checkoutAction(item.id)}>Pay {money(item.amountCents ?? 0)}</button>
                    </> : view.action === 'cancel' ? (
                      <button className="button button--quiet" disabled={busy} onClick={() => void cancel(item.id)}>Cancel reservation</button>
                    ) : null}
                  </BookingRow>
                );
              })}
            </div>
          ) : (
            <p className="empty-state booking-empty">No upcoming reservations. Choose equipment above to book one.</p>
          )}
          {sortedBookings.past.length || sortedBookings.cancelled.length ? <>
            <div className="booking-group">
              <h3>
                <button type="button" aria-expanded={pastOpen} aria-controls="past-bookings" onClick={() => setPastOpen(open => !open)}>
                  <ChevronDown aria-hidden="true" />Past · {sortedBookings.past.length}
                </button>
              </h3>
              {sortedBookings.cancelled.length ? (
                <label className="booking-group__toggle">
                  <input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)} />
                  <span>Show cancelled<span className="booking-group__long"> and expired</span> ({sortedBookings.cancelled.length})</span>
                </label>
              ) : null}
            </div>
            <div className="panel booking-history" id="past-bookings" hidden={!pastOpen}>
              {(showCancelled ? byStartDescending([...sortedBookings.past, ...sortedBookings.cancelled]) : sortedBookings.past).map(item => (
                <BookingRow key={item.id} item={item} view={describeBooking(item, now, user?.id, '')} machine={machineFor(item)} userId={user?.id} now={now} />
              ))}
              {!showCancelled && !sortedBookings.past.length ? <p className="booking-history__empty">Only cancelled or expired bookings so far.</p> : null}
            </div>
          </> : null}
        </> : null}
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
            <StartTimePicker calendar occupied={liveSelected?.occupied} unavailable={liveSelected?.status !== 'available'} minLeadMinutes={totalCents != null && totalCents > 0 ? 30 : 0} name="start" hours={duration} onPick={() => setError('')}>
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
                    {item.trainingRequired && item.trainingMinutes && <span>{item.trainingMinutes}-minute training required · <Link to="/classes">Find a training class</Link></span>}
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
            {liveSelected?.rate === null && <p className="form-notice">Rate not set. Contact staff before reserving.</p>}
            <EquipmentPriceBreakdown price={quote.data} />
            {quote.error && <p role="alert" className="form-error">{quote.error} <button type="button" onClick={quote.reload}>Refresh price</button></p>}
            <p className="form-caption">
              Cancel at least 24 hours before the start time. Leave 15 minutes between bookings for the same machine.
              {' '}Membership, training and waivers are checked when you book. Contact staff about refunds.
            </p>
            {totalCents !== null && <p className="equipment-payment-note" aria-live="polite">
              {totalCents > 0 ? 'Continue to secure checkout. Your reservation is confirmed after payment succeeds.' : 'No payment is required for this equipment.'}
            </p>}
            {error ? (
              <p ref={errorRef} tabIndex={-1} role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <button
              className="button button--primary equipment-booking-submit"
              type="submit"
              disabled={busy || liveSelected?.status !== 'available' || quote.loading || !!quote.error || totalCents === null || (!canBookForOthers && !liveSelected?.canReserve)}
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

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['pending', 'confirmed'];
const PAID_WORDS: Record<string, string> = { paid: 'Paid', refunded: 'Refunded', waived: 'Waived', failed: 'Payment failed' };
const time = (value: string) => new Date(value).getTime();
const byStartDescending = (items: Reservation[]) => [...items].sort((a, b) => time(b.startTime) - time(a.startTime));

/** Upcoming soonest first, with bookings waiting on this member's payment on top; past newest first. */
function splitBookings(items: Reservation[], now: number, userId: number | undefined) {
  const upcoming: Reservation[] = [], past: Reservation[] = [], cancelled: Reservation[] = [];
  for (const item of items) {
    if (!ACTIVE_STATUSES.includes(item.status)) cancelled.push(item);
    else if (time(item.endTime) > now) upcoming.push(item);
    else past.push(item);
  }
  const waitsOnMe = (item: Reservation) => item.paymentStatus === 'pending' && item.payerId != null && item.payerId === userId;
  upcoming.sort((a, b) => Number(waitsOnMe(b)) - Number(waitsOnMe(a)) || time(a.startTime) - time(b.startTime));
  return { upcoming, past: byStartDescending(past), cancelled: byStartDescending(cancelled) };
}

type BookingView = { status: string; tone: 'ok' | 'warn' | 'neutral'; note?: ReactNode; action?: 'pay' | 'cancel'; due?: boolean };

/** One status, one note and at most one kind of action for each booking. */
function describeBooking(item: Reservation, now: number, userId: number | undefined, blockReason: string): BookingView {
  const payment = item.paymentStatus ?? '';
  if (!ACTIVE_STATUSES.includes(item.status))
    return { status: payment === 'expired' ? 'Checkout expired' : item.status === 'expired' ? 'Expired' : 'Cancelled', tone: 'neutral' };
  if (time(item.endTime) <= now)
    return { status: ['Ended', payment === 'pending' ? 'Unpaid' : PAID_WORDS[payment]].filter(Boolean).join(' · '), tone: 'neutral' };
  if (payment === 'pending') {
    if (item.payerId != null && item.payerId !== userId) return { status: 'Awaiting payment', tone: 'warn', note: 'Awaiting payment from the person who started checkout.' };
    if (item.payerId === userId) return {
      status: blockReason ? 'Requirements need attention' : 'Awaiting payment', tone: 'warn', action: 'pay', due: true,
      note: blockReason || item.holdUntil ? <>
        {blockReason ? <>{blockReason}. <Link to="/certifications">Review your waivers and certifications</Link> before paying. </> : null}
        {item.holdUntil ? <>Complete payment by {dateTime(item.holdUntil)} to confirm this booking.</> : null}
      </> : undefined,
    };
  }
  // No checkout yet: payment is collected at the front desk, and the usual cancellation rules apply.
  const frontDesk = payment === 'pending';
  const confirmed = item.status === 'confirmed';
  const status = frontDesk ? 'Payment due at front desk' : confirmed ? ['Confirmed', PAID_WORDS[payment]].filter(Boolean).join(' · ') : 'Pending';
  const tone = confirmed && !frontDesk && payment !== 'failed' ? 'ok' : 'warn';
  const start = time(item.startTime);
  if (start <= now) return { status: 'In progress', tone: 'ok', note: `Ends at ${timeOnly(item.endTime)}.` };
  if (start >= now + DAY_MS)
    return { status, tone, action: 'cancel', note: `You can cancel online until ${dateTime(new Date(start - DAY_MS))}.` };
  return { status, tone, note: 'Online cancellation closes 24 hours before the start time.' };
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function dayLabel(value: string, now: number) {
  const start = new Date(value), today = new Date(now);
  return sameDay(start, today) ? 'Today' : shortDate(start, start.getFullYear() !== today.getFullYear());
}
function timeRange(startValue: string, endValue: string) {
  const start = new Date(startValue), end = new Date(endValue);
  return sameDay(start, end) ? `${timeOnly(start)} – ${timeOnly(end)}` : `${timeOnly(start)} – ${shortDate(end)}, ${timeOnly(end)}`;
}

/** Four tiles in the shape of the equipment tiles, shown until the catalog arrives. */
function EquipmentTilesLoading() {
  const widths: [string, string][] = [['62%', '86%'], ['48%', '70%'], ['70%', '40%'], ['44%', '62%']];
  return (
    <SkeletonGroup label="Loading equipment" className="equipment-grid">
      {widths.map(([title, names], index) => (
        <div className="equipment-card-skeleton" key={index}>
          <Skeleton className="equipment-card-skeleton__image" />
          <span className="equipment-card-skeleton__rule" />
          <Skeleton width={title} height={24} />
          <Skeleton width={names} height={13} />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Two rows on the booking row grid, shown until the reservations arrive. */
function BookingsLoading() {
  const widths: [string, string, string, string][] = [['58%', '40%', '46%', '62%'], ['44%', '52%', '38%', '56%']];
  return (
    <SkeletonGroup label="Loading reservations">
      <div className="booking-group" aria-hidden="true"><h3>Upcoming ·<Skeleton width={14} height={12} /></h3></div>
      <div className="booking-list">
        {widths.map(([name, detail, day, time], index) => (
          <div className="booking-row panel booking-row--card" key={index}>
            <div className="booking-row__thumb"><Skeleton width="100%" height="100%" /></div>
            <div className="booking-row__name skeleton-lines"><Skeleton width={name} height={16} /><Skeleton width={detail} height={12} /></div>
            <div className="booking-row__when skeleton-lines"><Skeleton width={day} height={16} /><Skeleton width={time} height={12} /></div>
            <div className="booking-row__price"><Skeleton width={index ? 48 : 56} height={16} /></div>
            <div className="booking-row__status"><Skeleton round width={index ? 80 : 92} height={22} /></div>
            <div className="booking-row__actions"><Skeleton round width={170} height={42} /></div>
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

function BookingRow({ item, view, machine, userId, now, card = false, children }: {
  item: Reservation; view: BookingView; machine: LiveEquipment | undefined; userId: number | undefined; now: number; card?: boolean; children?: ReactNode;
}) {
  const type = machine ? equipmentGroup(machine.type) : item.resourceType === 'room' ? 'Studio' : '';
  // Walk-up sessions store the machine's name as their location; don't repeat it.
  const place = item.location && item.location !== item.equipmentName ? item.location : '';
  const total = item.priceSnapshot?.totalCents ?? item.amountCents ?? null;
  const fee = item.priceSnapshot?.trainingFeeCents ?? 0;
  const detail = [type, place].filter(Boolean).join(' · ');
  return (
    <article className={`booking-row${card ? ' panel booking-row--card' : ''}${view.due ? ' booking-row--due' : ''}`}>
      <div className="booking-row__thumb reservation-card__image">
        {machine?.image ? <img src={machine.image} alt="" /> : <CalendarDays aria-hidden="true" />}
      </div>
      <div className="booking-row__name">
        <h3>{item.equipmentName}</h3>
        {detail ? <span>{detail}</span> : null}
        {item.userId !== userId && item.memberName ? <span className="booking-row__for">For {item.memberName}</span> : null}
      </div>
      <div className="booking-row__when">
        <strong>{dayLabel(item.startTime, now)}</strong>
        <span>{timeRange(item.startTime, item.endTime)}</span>
      </div>
      <div className="booking-row__price">
        {total === 0 ? <span className="booking-row__free">No charge</span> : total != null ? cents(total) : null}
        {fee > 0 ? <small>incl. {cents(fee)} training</small> : null}
      </div>
      <div className="booking-row__status"><span className={`status-pill status-pill--${view.tone}`}>{view.status}</span></div>
      <div className="booking-row__actions">{children}</div>
      {view.note ? <p className="booking-row__note">{view.note}</p> : null}
    </article>
  );
}

/** The display group for a machine type, shared by the equipment tiles and booking rows. */
function equipmentGroup(rawType: string) {
  const category = rawType.trim();
  return /^3d[ -]*(print|printing|printer)$/i.test(category) ? '3D Printer'
    : /\bcnc\b/i.test(category) ? 'CNC Machine'
    : /\blathe\b/i.test(category) ? 'Lathe'
    : /^laser( engraver)?$/i.test(category) ? 'Laser Engraver'
    : category || 'Other equipment';
}

// Group presentation only; booking always retains the original machine record.
function groupEquipment(equipment: LiveEquipment[]): [string, LiveEquipment[]][] {
  const groups = new Map<string, LiveEquipment[]>();
  for (const item of equipment) {
    const type = equipmentGroup(item.type);
    groups.set(type, [...(groups.get(type) ?? []), item]);
  }
  const order = ['3D Printer', 'Laser Engraver', 'Lathe', 'CNC Machine'];
  return [...groups].sort(([a], [b]) => {
    const rank = (type: string) => order.includes(type) ? order.indexOf(type) : order.length;
    return rank(a) - rank(b);
  });
}
