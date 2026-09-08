import { CalendarDays, Clock3, Filter, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { classes } from '../data/mockData';

export function ClassesPage() {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => classes.filter((item) => (item.title + ' ' + item.equipment + ' ' + item.instructor).toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <div className="classes-page page-enter">
      <p className="form-notice">Catalog preview: sample classes only. Registration is not available and no class bookings are saved.</p>
      <section className="catalog-hero">
        <div><p className="eyebrow">Learn by making</p><h1>Classes</h1><p>Hands-on training led by working makers. Build skills, earn certifications, and unlock more equipment.</p></div>
        <label className="catalog-search"><Filter aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter classes…" aria-label="Filter classes" /></label>
      </section>
      <section className="class-catalog" aria-label="Available classes">
        {visible.map((item) => {
          return (
            <article className="catalog-card panel" key={item.id}>
              <div className="catalog-card__image"><img src={item.image} alt="" /><span>{item.enrolled} / {item.capacity} spots</span></div>
              <div className="catalog-card__body">
                <p className="eyebrow">{item.equipment}</p>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <dl>
                  <div><dt><CalendarDays aria-hidden="true" /> Date</dt><dd>{item.date}</dd></div>
                  <div><dt><Clock3 aria-hidden="true" /> Time</dt><dd>{item.time}</dd></div>
                  <div><dt><Users aria-hidden="true" /> Instructor</dt><dd>{item.instructor}</dd></div>
                </dl>
                <div className="catalog-card__footer"><strong>${item.price.toFixed(2)}</strong><button className="button button--quiet" disabled>Registration coming later</button></div>
              </div>
            </article>
          );
        })}
        {!visible.length ? <p className="empty-state">No classes match “{query}.”</p> : null}
      </section>
    </div>
  );
}
