import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, Check, Nfc } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { editingFormRef } from '../../lib/editingForms';
import { useApi } from '../../lib/useApi';
import { Modal } from '../../components/Modal';
import { LoadState } from '../../components/Management';
import { equipmentTime, type EquipmentDetail } from '../../lib/equipmentMaintenance';

const NEW_CATEGORY = '__new__';
export interface RemovalBlockers {
  sessions: { readerId: string; expiresAt: string; members: (string | null)[] }[];
  bookings: { id: number; member: string | null; startTime: string; endTime: string }[];
}
export interface CatalogOptions { canManage: boolean; categories: string[]; certifications: { id: number; name: string }[] }
export function EquipmentEditor({ initial: suppliedInitial, onClose, onSaved }: { initial?: EquipmentDetail; onClose: () => void; onSaved: (id: number, removed: boolean) => void }) {
  const initial = useRef(suppliedInitial).current;
  const options = useApi<CatalogOptions>('/admin/equipment/catalog-options');
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? '');
  const [newCategory, setNewCategory] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const categories = [...new Set([...(options.data?.categories ?? []), ...(initial?.type ? [initial.type] : [])])].sort((a, b) => a.localeCompare(b));
  const [location, setLocation] = useState(initial?.location ?? 'Makerspace');
  const [image, setImage] = useState(initial?.imagePath ?? '');
  const [rate, setRate] = useState(initial?.rate?.toString() ?? '');
  const [certId, setCertId] = useState(initial?.certId?.toString() ?? '');
  const [waiverRequired, setWaiverRequired] = useState(initial?.waiverRequired ?? true);
  const [dirty, setDirty] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const blockers = useApi<RemovalBlockers>(removing && initial ? `/admin/equipment/${initial.id}/removal-blockers` : null);
  const blocked = !blockers.data || blockers.data.sessions.length + blockers.data.bookings.length > 0;
  const save = async (remove: boolean) => {
    if (inFlight.current) return;
    if (!remove && newCategory && !categoryName.trim()) { setError('Type a name for the new category.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      const saved = await api<{ id: number }>(`/admin/equipment${initial ? `/${initial.id}` : ''}`, {
        method: remove ? 'DELETE' : initial ? 'PUT' : 'POST',
        body: { name, type: newCategory ? categoryName.trim() : type, location, image, rate: rate === '' ? null : Number(rate), certId: certId === '' ? null : Number(certId), waiverRequired, expectedRevision: initial?.availabilityRevision },
      });
      onSaved(saved.id, remove);
    } catch (err) { setError(errorMessage(err)); if (remove) blockers.reload(); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal open title={initial ? 'Edit equipment' : 'Add equipment'} onClose={onClose} dirty={dirty} dismissible={!busy}>
    {close => <>
      <LoadState {...options} />
      {removing && initial ? <div className="eq-remove">
        <h3>Remove {initial.name}?</h3>
        <p>{initial.name} leaves the equipment catalog and can no longer be booked or unlocked.</p>
        <p className="eq-remove__kept"><Check aria-hidden="true" />Kept: bookings, payments and service history</p>
        <LoadState {...blockers} loading={blockers.loading && !blockers.data} />
        {blockers.data && blocked && <div className="eq-blockers" role="status"><h4>Resolve this first</h4><ul>
          {blockers.data.sessions.map(session => <li key={session.readerId}><Nfc aria-hidden="true" /><span><b>In use on {session.readerId}</b><small>{session.members.filter(Boolean).join(', ') || 'A member'} · until {equipmentTime(session.expiresAt, initial.timeZone)}</small></span></li>)}
          {blockers.data.bookings.map(booking => <li key={booking.id}><CalendarDays aria-hidden="true" /><span><b>Booking #{booking.id}</b><small>{equipmentTime(booking.startTime, initial.timeZone)} · {booking.member ?? 'Member'}</small></span><Link className="button button--quiet" to={`/admin/reservations?equipmentId=${initial.id}`}>Open bookings<ArrowUpRight aria-hidden="true" /></Link></li>)}
        </ul><p>{[blockers.data.sessions.length ? 'Wait for the session to end' : '', blockers.data.bookings.length ? 'move or cancel the bookings' : ''].filter(Boolean).join(' and ').replace(/^m/, 'M')}, then come back to remove {initial.name}.</p></div>}
        <div className="eq-actions"><button className="button button--danger-action" disabled={busy || blocked} onClick={() => void save(true)}>{busy ? 'Removing…' : 'Confirm removal'}</button><button className="button button--quiet" disabled={busy} onClick={() => { setRemoving(false); setError(''); }}>Keep equipment</button></div>
      </div> : <form ref={editingFormRef} className="management-form eq-form" onChange={() => setDirty(true)} onSubmit={(event: FormEvent) => { event.preventDefault(); void save(false); }}>
        <label>Name<input required maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <label>Category<select required value={newCategory ? NEW_CATEGORY : type} disabled={busy || !options.data} onChange={e => { const value = e.target.value; setNewCategory(value === NEW_CATEGORY); if (value !== NEW_CATEGORY) setType(value); }}><option value="">Choose a category…</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}<option value={NEW_CATEGORY}>+ New category…</option></select></label>
        {newCategory && <label>New category name<input required autoFocus maxLength={100} value={categoryName} disabled={busy} onChange={e => setCategoryName(e.target.value)} /><small>Other equipment can use this category after you save.</small></label>}
        <label>Location<input required maxLength={100} value={location} disabled={busy} onChange={e => setLocation(e.target.value)} /></label>
        <label>Hourly rate ($)<input type="number" min="0" max="99999999.99" step="0.01" value={rate} disabled={busy} onChange={e => setRate(e.target.value)} /><small>Leave blank for no rate set. Enter 0 for free use. Rate changes apply to new quotes; existing payment records are preserved.</small></label>
        <label>Image path or HTTPS URL<input maxLength={255} value={image} disabled={busy} onChange={e => setImage(e.target.value)} /></label>
        <label>Required certification<select value={certId} disabled={busy || !options.data} onChange={e => setCertId(e.target.value)}><option value="">None</option>{options.data?.certifications.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="eq-confirm"><input type="checkbox" checked={waiverRequired} disabled={busy} onChange={e => setWaiverRequired(e.target.checked)} />Require signed waivers</label>
        <div className="eq-actions"><button className="button button--primary" disabled={busy || !options.data?.canManage}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Add equipment'}</button><button type="button" className="button button--quiet" disabled={busy} onClick={close}>Cancel</button></div>
        {initial && <div className="eq-private-note"><h3>Remove equipment</h3><p>Remove this machine from the catalog while keeping its history.</p><button type="button" className="button button--danger" disabled={busy || !options.data?.canManage} onClick={() => setRemoving(true)}>Remove equipment</button></div>}
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>}
  </Modal>;
}
