// A shared details editor for reusable workshops and their scheduled sessions.
import { useRef, useState, type FormEvent } from 'react';
import { Modal } from '../Modal';
import { api, errorMessage } from '../../lib/api';
import { EquipmentImagePicker, type EquipmentImageChoice } from '../../pages/admin/EquipmentImagePicker';
import { classPhoto, workshopImage, type ClassRecord, type WorkshopTemplate } from './classData';

export const classImages = [
  ['resin-charcuterie', 'Resin charcuterie board'], ['resin-platter', 'Resin platter'],
  ['resin-glass-art', 'Resin and glass art'], ['resin-nightlight', 'Floral nightlight'],
  ['laser-class', 'Laser training'], ['printing-class', 'Printing training'],
  ['cnc-machine', 'CNC training'], ['wood-lathe', 'Wood lathe'], ['metal-lathe-class', 'Metal lathe'],
].map(([file, label]) => ({ path: `/assets/${file}.webp`, label: label! }));

export function ClassEditorDialog({ initial, catalog = false, onClose, onSaved }: {
  initial?: WorkshopTemplate | ClassRecord; catalog?: boolean; onClose: () => void; onSaved: (removed?: boolean) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 15));
  const [image, setImage] = useState<EquipmentImageChoice>({ path: initial?.image ?? '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const busy = saving || processing;
  const fallback = initial && 'certificationId' in initial ? classPhoto({ ...initial, image: null }).src : workshopImage(title).src;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || processing) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      await api(`/classes${catalog ? '/catalog' : ''}${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PUT' : 'POST',
        body: { title, description, capacity: Number(capacity), image: image.path, ...(image.upload ? { imageUpload: image.upload } : {}), expectedRevision: initial?.revision },
      });
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
    finally { inFlight.current = false; setSaving(false); }
  }
  async function remove() {
    if (!initial || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      await api(`/classes/catalog/${initial.id}`, { method: 'DELETE', body: { expectedRevision: initial.revision } });
      onSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal open title={removing ? 'Remove class' : initial ? 'Edit class' : 'Add class'} onClose={onClose} dirty={dirty} dismissible={!busy}>
    {close => removing ? <div className="class-form">
      <p>Remove <strong>{initial?.title}</strong> from the class catalog?</p>
      <p>It will no longer appear in the catalog or be available for new sessions. Existing sessions, rosters and attendance history stay available. Cancel upcoming sessions separately under Scheduled sessions if needed.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="class-dialog-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={() => { setRemoving(false); setError(''); }}>Keep class</button><button type="button" className="button button--danger-action" disabled={busy} onClick={() => void remove()}>{saving ? 'Removing…' : 'Confirm removal'}</button></div>
    </div> : <form className="class-form" onChange={() => setDirty(true)} onSubmit={event => void submit(event)}>
      <p>{catalog ? 'Catalog details are defaults for new sessions. Existing sessions keep their own details.' : 'Changes appear on the member class page as soon as you save.'}</p>
      <fieldset disabled={busy}>
        <label className="class-field">Class title<input required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="class-field">Description<textarea rows={5} maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="class-field">Roster size<input required type="number" min={initial && 'enrolled' in initial ? Math.max(1, initial.enrolled) : 1} max={15} value={capacity} onChange={e => setCapacity(e.target.value)} /><small>1–15 people; scheduled sessions must also fit their room and current enrollment.</small></label>
      </fieldset>
      <EquipmentImagePicker subject="class" defaultImage={fallback} value={image} images={classImages} disabled={busy} onProcessing={setProcessing} onChange={choice => { setImage(choice); setDirty(true); }} />
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="class-dialog-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={close}>Cancel</button><button className="button button--primary" disabled={busy}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add class'}</button></div>
      {catalog && initial && <div className="class-editor-removal"><h3>Remove class</h3><p>Remove this workshop from the catalog while keeping its sessions and history.</p><button type="button" className="button button--danger" disabled={busy} onClick={() => setRemoving(true)}>Remove class</button></div>}
    </form>}
  </Modal>;
}
