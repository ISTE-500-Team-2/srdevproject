import { CalendarDays, CheckCircle2, Clock3, Filter, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { classes } from '../data/mockData';

export function ClassesPage() {
  const [query, setQuery] = useState('');
  const [registered, setRegistered] = useState<number[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const visible = useMemo(() => classes.filter((item) => (item.title + ' ' + item.equipment + ' ' + item.instructor).toLowerCase().includes(query.toLowerCase())), [query]);

  const register = (id: number, title: string) => {
    setRegistered((items) => items.includes(id) ? items : [...items, id]);
    setToast('You’re registered for ' + title + '.');
    window.setTimeout(() => setToast(null), 2600);
  };

  return (
    <div className="classes-page page-enter">
      <section className="catalog-hero">
        <div><p className="eyebrow">Learn by making</p><h1>Classes</h1><p>Hands-on training led by working makers. Build skills, earn certifications, and unlock more equipment.</p></div>
        <label className="catalog-search"><Filter aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter classes…" aria-label="Filter classes" /></label>
      </section>
      <section className="class-catalog" aria-label="Available classes">
        {visible.map((item) => {
          const isRegistered = registered.includes(item.id);
          return (
            <article className="catalog-card panel" key={item.id}>
              <div className="catalog-card__image"><img src={item.image} alt="" /><span>{item.enrolled + (isRegistered ? 1 : 0)} / {item.capacity} spots</span></div>
              <div className="catalog-card__body">
                <p className="eyebrow">{item.equipment}</p>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <dl>
                  <div><dt><CalendarDays aria-hidden="true" /> Date</dt><dd>{item.date}</dd></div>
                  <div><dt><Clock3 aria-hidden="true" /> Time</dt><dd>{item.time}</dd></div>
                  <div><dt><Users aria-hidden="true" /> Instructor</dt><dd>{item.instructor}</dd></div>
                </dl>
                <div className="catalog-card__footer"><strong>${item.price.toFixed(2)}</strong><button className={isRegistered ? 'button button--confirmed' : 'button button--primary'} disabled={isRegistered} onClick={() => register(item.id, item.title)}>{isRegistered ? <><CheckCircle2 aria-hidden="true" /> Registered</> : 'Reserve a spot'}</button></div>
              </div>
            </article>
          );
        })}
        {!visible.length ? <p className="empty-state">No classes match “{query}.”</p> : null}
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
