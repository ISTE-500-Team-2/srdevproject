import { useId, useState } from 'react';
import { useHoldHeight } from '../../components/admin/steadyHeight';
import { onArrowKeys } from '../../lib/rovingFocus';
import { Plus } from 'lucide-react';
import { ClassesPage } from '../ClassesPage';
import { useApi } from '../../lib/useApi';
import { LoadState } from '../../components/Management';
import { Toast } from '../../components/Toast';
import { ClassEditorDialog } from '../../components/classes/ClassEditorDialog';
import { ClassThumb } from '../../components/classes/ClassBits';
import { workshopImage, WORKSHOP_LABEL, type WorkshopTemplate } from '../../components/classes/classData';

export function ClassManagementPage() {
  const [view, setView] = useState<'catalog' | 'schedule'>('catalog');
  const holdHeight = useHoldHeight();
  const ids = useId();
  const choose = (next: 'catalog' | 'schedule') => { if (next !== view) { holdHeight(); setView(next); } };
  const catalog = useApi<WorkshopTemplate[]>('/classes/catalog');
  const [editing, setEditing] = useState<WorkshopTemplate | 'new' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  return <section className="classes-page classes-management">
    <header className="admin-page-heading"><p className="admin-page-eyebrow">Operations</p><h1 className="admin-title">Classes</h1><p>Manage class details, schedule sessions and review rosters.</p></header>
    <div className="class-tabs" role="tablist" aria-label="Class management views" onKeyDown={onArrowKeys}>
      <button id={`${ids}-catalog-tab`} type="button" role="tab" aria-selected={view === 'catalog'} aria-controls={`${ids}-catalog`} tabIndex={view === 'catalog' ? 0 : -1} className="class-tab" onClick={() => choose('catalog')}>Class catalog</button>
      <button id={`${ids}-schedule-tab`} type="button" role="tab" aria-selected={view === 'schedule'} aria-controls={`${ids}-schedule`} tabIndex={view === 'schedule' ? 0 : -1} className="class-tab" onClick={() => choose('schedule')}>Scheduled sessions</button>
    </div>
    <div id={`${ids}-catalog`} className="classes-management__panel" role="tabpanel" aria-labelledby={`${ids}-catalog-tab`} hidden={view !== 'catalog'}>
      <div className="classes-head"><div><h2>Class catalog</h2><p>Create workshops here, then publish a session under Scheduled sessions.</p></div><button className="button button--primary" onClick={() => setEditing('new')}><Plus aria-hidden="true" />Add class</button></div>
      <LoadState {...catalog} />
      {catalog.data && <ul className="workshop-grid">{catalog.data.map(item => <li key={item.id} className="workshop-card">
        <ClassThumb certification={WORKSHOP_LABEL} photo={item.image ? { src: item.image, cutout: false } : workshopImage(item.title)} />
        <h3>{item.title}</h3><p>{item.description}</p><footer><span>Up to {item.capacity} people</span><button type="button" className="button button--quiet" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)}>Edit class</button></footer>
      </li>)}</ul>}
      {catalog.data?.length === 0 && <p>No classes yet. Add a class to start the catalog.</p>}
    </div>
    <div id={`${ids}-schedule`} className="classes-management__panel" role="tabpanel" aria-labelledby={`${ids}-schedule-tab`} hidden={view !== 'schedule'}><ClassesPage workspace /></div>
    {editing && <ClassEditorDialog catalog initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(removed) => { setEditing(null); catalog.reload(); setToast(removed ? 'Class removed from catalog.' : 'Class saved.'); }} />}
    <Toast message={toast} onClose={() => setToast(null)} />
  </section>;
}
