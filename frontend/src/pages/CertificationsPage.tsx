import { CheckCircle2, ChevronDown, ChevronUp, CircleX, Clock3, FileText, Filter } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Toast } from '../components/Toast';
import { certifications, classes, waivers } from '../data/mockData';
import type { CredentialRecord, WorkshopClass } from '../types';

export function CertificationsPage() {
  const [openSections, setOpenSections] = useState({ available: true, upcoming: false, completed: true });
  const [registeredIds, setRegisteredIds] = useState<number[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const toggle = (key: keyof typeof openSections) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const register = (item: WorkshopClass) => {
    if (!registeredIds.includes(item.id)) {
      setRegisteredIds((ids) => [...ids, item.id]);
      setToast('You’re registered for ' + item.title + '.');
      window.setTimeout(() => setToast(null), 2600);
    }
  };

  return (
    <div className="credentials-page page-enter">
      <section className="credentials-page__records">
        <CredentialSection title="Your Certifications" records={certifications} />
        <div className="dashboard-divider" />
        <CredentialSection title="Your Waivers" records={waivers} />
      </section>

      <section className="training-panel">
        <div className="training-panel__heading">
          <div><p className="eyebrow">Build your skills</p><h1>Schedule Training</h1></div>
          <button className="button button--quiet"><Filter aria-hidden="true" /> Filter</button>
        </div>

        <TrainingGroup title="Available" open={openSections.available} onToggle={() => toggle('available')}>
          {classes.slice(1).map((item) => (
            <TrainingCard
              key={item.id}
              item={item}
              registered={registeredIds.includes(item.id)}
              onRegister={() => register(item)}
            />
          ))}
        </TrainingGroup>

        <TrainingGroup title={'Upcoming (' + registeredIds.length + ')'} open={openSections.upcoming} onToggle={() => toggle('upcoming')}>
          {registeredIds.length ? classes.filter((item) => registeredIds.includes(item.id)).map((item) => (
            <TrainingCard key={item.id} item={item} registered onRegister={() => register(item)} />
          )) : <p className="training-panel__empty">Registered sessions will appear here.</p>}
        </TrainingGroup>

        <TrainingGroup title="Completed" open={openSections.completed} onToggle={() => toggle('completed')}>
          <TrainingCard item={{ ...classes[0], title: 'CNC Training', equipment: 'CNC Machine', status: 'completed' }} registered onRegister={() => undefined} />
        </TrainingGroup>
      </section>

      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function CredentialSection({ title, records }: { title: string; records: CredentialRecord[] }) {
  return (
    <section>
      <h2 className="display-heading">{title}</h2>
      <div className="credential-table panel">
        <div className="credential-table__header"><span>{title.includes('Waivers') ? 'Waiver Name' : 'Equipment Name'}</span><span>{title.includes('Waivers') ? 'Signed Status' : 'Completion Status'}</span><span>{title.includes('Waivers') ? 'Date Signed' : 'Date Completed'}</span></div>
        {records.map((record) => {
          const complete = record.status === 'Complete' || record.status === 'Signed';
          return (
            <div className="credential-table__row" key={record.id}>
              <span><FileText aria-hidden="true" /> {record.name}</span>
              <span>{record.status} {complete ? <CheckCircle2 className="status-good" aria-label="Complete" /> : <CircleX className="status-bad" aria-label="Incomplete" />}</span>
              <span className={record.date ? '' : 'is-muted'}>{record.date ?? 'MM/DD/YYYY'}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TrainingGroup({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="training-group">
      <button className="training-group__toggle" onClick={onToggle} aria-expanded={open}>
        <span>{title}</span>{open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
      {open ? <div className="training-group__content">{children}</div> : null}
    </section>
  );
}

function TrainingCard({ item, registered, onRegister }: { item: WorkshopClass; registered: boolean; onRegister: () => void }) {
  return (
    <article className="training-card">
      <div className="training-card__top"><h3>{item.title}</h3><strong>${item.price.toFixed(2)}</strong></div>
      <p><Clock3 aria-hidden="true" /> {item.duration}</p>
      <p>{item.description}</p>
      <button className={registered ? 'button button--confirmed' : 'button button--primary'} onClick={onRegister} disabled={registered}>
        {registered ? <><CheckCircle2 aria-hidden="true" /> {item.status === 'completed' ? 'Completed' : 'Registered'}</> : 'Sign up now!'}
      </button>
    </article>
  );
}
