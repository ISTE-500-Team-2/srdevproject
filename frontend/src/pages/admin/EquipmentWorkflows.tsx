import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Modal } from '../../components/Modal';
import { LoadState } from '../../components/Management';
import type { Page } from '../../lib/staffContracts';
import { zonedDay } from '../../lib/display';
import { equipmentRate, equipmentTime, maintenanceReasons, type EquipmentDetail, type EquipmentBooking, type ManagedEquipment, type MoveReview } from '../../lib/equipmentMaintenance';

export function AvailabilityForm({ initial, onClose, onSaved }: { initial: EquipmentDetail; onClose: () => void; onSaved: (text: string) => void }) {
  const restore = useRef(initial.status !== 'available').current;
  const [checked, setChecked] = useState<EquipmentDetail | null>(initial);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [expectedBack, setExpectedBack] = useState('');
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const recheck = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { setChecked(await api<EquipmentDetail>(`/admin/equipment/${initial.id}`)); }
    catch (err) { setChecked(null); setError(errorMessage(err)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const inUse = !!checked?.activeGrants.length;
  const wrongStatus = checked && (checked.status !== 'available') !== restore;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!checked || inFlight.current || wrongStatus || (!restore && (inUse || !stopped || !reason))) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(`/admin/equipment/${initial.id}/${restore ? 'restore' : 'outage'}`, { method: 'POST', body: { expectedRevision: checked.availabilityRevision, note, reason, expectedBack, stopped } });
      onSaved(restore ? `${initial.name} is available again. Existing bookings are unchanged.` : `${initial.name} is out of service. Review upcoming bookings below.`);
    } catch (err) { setChecked(null); setError(errorMessage(err)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <form className="management-form eq-form" onSubmit={save}>
    <h3>{restore ? 'Ready for members again?' : 'Take out of service'}</h3>
    <p>{restore ? 'New bookings and reader access will be available again.' : 'This immediately blocks new bookings and reader access.'} Existing bookings stay in place. No email is sent for this status change.</p>
    {!restore && <>
      <label>Reason <select aria-label="Reason" required value={reason} disabled={busy} onChange={e => setReason(e.target.value)}><option value="">Choose a reason…</option>{Object.entries(maintenanceReasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Estimated return <span className="eq-muted">(optional)</span><input type="date" min={zonedDay(initial.timeZone)} value={expectedBack} disabled={busy} onChange={e => setExpectedBack(e.target.value)} /><small>An estimate only. Return to service is always manual.</small></label>
    </>}
    <label>{restore ? 'Completion note' : 'Staff note'} <span className="eq-muted">(optional, staff only)</span><textarea rows={3} maxLength={500} value={note} disabled={busy} onChange={e => setNote(e.target.value)} /><small>{note.length}/500</small></label>
    {!restore && <label className="eq-confirm"><input type="checkbox" checked={stopped} disabled={busy} onChange={e => setStopped(e.target.checked)} /><span>I confirm the equipment is physically stopped and ready for maintenance.</span></label>}
    {!restore && inUse && <div className="eq-warning" role="status"><strong>Waiting for an active session</strong><p>{checked!.activeGrants.flatMap(g => g.members).filter(Boolean).join(', ') || 'A member'} is using this equipment. Recheck when the session ends or its reservation expires. Your draft will stay here.</p></div>}
    {wrongStatus && <p className="eq-warning">Availability has changed. Close this form and refresh the page.</p>}
    {!checked && <p className="eq-warning">Recheck the current equipment status before saving. Your draft is preserved.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="eq-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={() => void recheck()}><RefreshCw aria-hidden="true" />{busy ? 'Checking…' : 'Check again'}</button>
      <button type="submit" className="button button--primary" disabled={busy || !checked || !checked.canManage || !!wrongStatus || (!restore && (!reason || !stopped || inUse))}>{restore ? 'Return to service' : 'Confirm out of service'}</button>
      <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>Keep current status</button></div>
  </form>;
}

export function EquipmentBookings({ machine, onChanged }: { machine: EquipmentDetail; onChanged: (text: string) => void }) {
  const [selection, setSelection] = useState<{ booking: EquipmentBooking; action: 'move' | 'cancel' } | null>(null);
  return <section className="eq-panel eq-bookings"><div className="eq-section-head"><h2>Upcoming bookings</h2><Link to={`/admin/reservations?equipmentId=${machine.id}`}>All reservations</Link></div>
    <p>{machine.status === 'available' ? 'Current and future bookings for this machine.' : 'Review each booking while this machine is unavailable. Nothing has been cancelled automatically.'}</p>
    <p className="eq-muted">Times in {machine.timeZone.replaceAll('_', ' ')}. Includes bookings beyond today and the estimated return date.</p>
    <BookingPage machine={machine} offset={0} select={(booking, action) => setSelection({ booking, action })} />
    {selection && <BookingAction machine={machine} {...selection} onClose={() => setSelection(null)} onChanged={onChanged} />}
  </section>;
}
function BookingPage({ machine, offset, select }: { machine: EquipmentDetail; offset: number; select: (b: EquipmentBooking, action: 'move' | 'cancel') => void }) {
  const result = useApi<Page<EquipmentBooking>>(`/admin/equipment/${machine.id}/bookings?offset=${offset}`, { retainOnReload: true });
  const [more, setMore] = useState(false);
  return <><LoadState {...result} />
    {offset === 0 && result.data?.items.length === 0 && <p className="eq-empty">No upcoming bookings to review.</p>}
    {result.data?.items.map(b => <article className="eq-booking" key={b.id}>
      <div><strong>{b.memberName ?? 'Member'}</strong><span>{equipmentTime(b.startTime, machine.timeZone)} – {new Intl.DateTimeFormat('en-US', { timeZone: machine.timeZone, timeStyle: 'short' }).format(new Date(b.endTime))}</span><small>Booking #{b.id}{b.isClass ? ' · Training class' : ''}</small></div>
      {b.isClass ? <Link to="/admin/certifications?section=certifications">Manage training</Link> : machine.canManageBookings && <div className="eq-actions"><button className="button button--quiet" disabled={Date.parse(b.startTime) <= Date.now()} onClick={() => select(b, 'move')}>Move</button><button className="button button--quiet" onClick={() => select(b, 'cancel')}>Cancel booking</button></div>}
    </article>)}
    {result.data?.nextOffset != null && (more ? <BookingPage machine={machine} offset={result.data.nextOffset} select={select} /> : <button className="button button--quiet" onClick={() => setMore(true)}>Load more bookings</button>)}
  </>;
}
function BookingAction({ machine, booking, action, onClose, onChanged }: { machine: EquipmentDetail; booking: EquipmentBooking; action: 'move' | 'cancel'; onClose: () => void; onChanged: (text: string) => void }) {
  const catalog = useApi<ManagedEquipment[]>(action === 'move' ? '/admin/equipment' : null);
  const [target, setTarget] = useState('');
  const [review, setReview] = useState<MoveReview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const perform = async (confirm: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const operation = action === 'cancel' ? 'cancel' : confirm ? 'move' : 'review-move';
      const result = await api<MoveReview>(`/admin/equipment/${machine.id}/bookings/${booking.id}/${operation}`, { method: 'POST', body: {
        expectedRevision: booking.revision, ...(action === 'move' ? { equipmentId: Number(target), ...(confirm ? { expectedRate: review?.rate } : {}) } : {}),
      } });
      if (operation === 'review-move') setReview(result);
      else { onClose(); onChanged(`Booking ${action === 'cancel' ? 'cancelled' : 'moved'}. Confirmation follows the member’s email preferences.`); }
    } catch (err) { setReview(null); setError(errorMessage(err)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal open title={action === 'cancel' ? 'Cancel this booking?' : 'Move booking'} onClose={onClose} dismissible={!busy} dirty={!!target}>
    {requestClose => <div className="eq-workspace eq-booking-dialog">
      <p><strong>{booking.memberName}</strong> · {machine.name}</p><p>{equipmentTime(booking.startTime, machine.timeZone)} – {equipmentTime(booking.endTime, machine.timeZone)}</p>
      {action === 'cancel' ? <><p>This cancels only this booking. A cancellation confirmation follows the member’s email preferences.</p><div className="eq-private-note"><span className="eq-eyebrow">Confirmation summary</span><p>Your reservation for {machine.name} on {equipmentTime(booking.startTime, machine.timeZone)} has been cancelled.</p></div></> : <>
        <LoadState {...catalog} /><label className="eq-field">Replacement machine<select aria-label="Replacement machine" value={target} disabled={busy} onChange={e => { setTarget(e.target.value); setReview(null); setError(''); }}><option value="">Choose equipment…</option>{catalog.data?.filter(m => m.status === 'available' && m.id !== machine.id).map(m => <option key={m.id} value={m.id}>{m.name} · {equipmentRate(m.rate)}</option>)}</select></label>
        <p className="eq-muted">The member and booking time stay the same. Eligibility and availability are checked before you confirm.</p>
        {review && <div className="eq-move-review" role="status"><h3>Move to {review.equipmentName}</h3><p><Check aria-hidden="true" /> Membership, certification and waivers checked</p><p><Check aria-hidden="true" /> Full time slot and 15-minute gap available</p><p><strong>{equipmentRate(review.oldRate)} → {equipmentRate(review.rate)}</strong></p><p>No payment is collected by this change. All checks run again when you confirm.</p><p>An updated confirmation follows the member’s email preferences.</p></div>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="eq-actions"><button className="button button--quiet" disabled={busy} onClick={requestClose}>Keep booking</button>
        <button className="button button--primary" disabled={busy || (action === 'move' && !target)} onClick={() => void perform(action === 'cancel' || !!review)}>{busy ? 'Checking…' : action === 'cancel' ? 'Confirm cancellation' : review ? 'Confirm move' : 'Review move'}</button></div>
    </div>}
  </Modal>;
}
