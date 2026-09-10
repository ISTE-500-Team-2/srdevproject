import { ArrowLeft, ArrowRight, CalendarDays, Filter, ShieldAlert, Sparkles } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { equipment, studioSpaces } from '../data/mockData';
import type { Equipment, StudioSpace } from '../types';

type Reservable = Equipment | StudioSpace;

export function ReservationsPage() {
  const [equipmentOffset, setEquipmentOffset] = useState(0);
  const [spaceOffset, setSpaceOffset] = useState(0);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Reservable | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const visibleEquipment = useMemo(() => {
    const filtered = equipment.filter((item) => filter === 'all' || (filter === 'trained' ? !item.trainingRequired : item.trainingRequired));
    return rotate(filtered, equipmentOffset);
  }, [equipmentOffset, filter]);
  const visibleSpaces = useMemo(() => rotate(studioSpaces, spaceOffset), [spaceOffset]);

  const confirmReservation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setToast('Reservation request created for ' + selected.name + '.');
    setSelected(null);
    window.setTimeout(() => setToast(null), 2800);
  };

  return (
    <div className="reservations-page page-enter">
      <section className="reservation-section">
        <div className="reservation-section__heading">
          <div><p className="eyebrow">Reserve by the hour</p><h1>Equipment</h1></div>
          <div className="reservation-section__tools">
            <label className="select-control"><Filter aria-hidden="true" /><span>Filter</span><select value={filter} onChange={(event) => { setFilter(event.target.value); setEquipmentOffset(0); }}><option value="all">All equipment</option><option value="trained">Ready to reserve</option><option value="training">Training required</option></select></label>
            <CarouselButtons label="equipment" onPrevious={() => setEquipmentOffset((value) => value - 1)} onNext={() => setEquipmentOffset((value) => value + 1)} />
          </div>
        </div>
        <div className="equipment-grid">
          {visibleEquipment.map((item) => (
            <button className="reservation-card equipment-card" key={item.id} onClick={() => setSelected(item)}>
              <div className="reservation-card__image"><img src={item.image} alt="" /></div>
              <div className="reservation-card__rule" />
              <div className="reservation-card__title"><h2>{item.name}</h2>{item.trainingRequired ? <span><ShieldAlert aria-hidden="true" /> Training required</span> : null}</div>
              <div className="reservation-card__meta"><span>{item.type}</span><strong>${item.rate.toFixed(2)}/hour</strong></div>
              <small>{item.availability}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="dashboard-divider" />

      <section className="reservation-section">
        <div className="reservation-section__heading">
          <div><p className="eyebrow">Make it your own</p><h1>Studio Spaces</h1></div>
          <CarouselButtons label="studio spaces" onPrevious={() => setSpaceOffset((value) => value - 1)} onNext={() => setSpaceOffset((value) => value + 1)} />
        </div>
        <div className="studio-grid">
          {visibleSpaces.map((item) => (
            <button className="reservation-card studio-card" key={item.id} onClick={() => setSelected(item)}>
              <div className="studio-card__image"><img src={item.image} alt="" /></div>
              <div className="reservation-card__rule" />
              <div className="reservation-card__title"><h2>{item.name}</h2><span>{item.size}</span></div>
              <div className="reservation-card__meta"><span>{item.description}</span><strong>${item.monthlyRate.toFixed(2)}/month</strong></div>
              <small>{item.availability}</small>
            </button>
          ))}
        </div>
      </section>

      <Modal open={Boolean(selected)} title={selected ? 'Reserve ' + selected.name : 'Create reservation'} onClose={() => setSelected(null)}>
        {selected ? (
          <form className="reservation-form" onSubmit={confirmReservation}>
            <div className="reservation-form__summary">
              <img src={selected.image} alt="" />
              <div><p className="eyebrow">{'rate' in selected ? selected.type : selected.size + ' studio'}</p><h3>{selected.name}</h3><span>{'rate' in selected ? '$' + selected.rate.toFixed(2) + '/hour' : '$' + selected.monthlyRate.toFixed(2) + '/month'}</span></div>
            </div>
            <div className="two-column-fields">
              <label className="form-field"><span>Start date</span><input type="date" required /></label>
              {'rate' in selected ? <label className="form-field"><span>Start time</span><input type="time" required /></label> : <label className="form-field"><span>Lease term</span><select defaultValue="1"><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option></select></label>}
            </div>
            {'rate' in selected ? <label className="form-field"><span>Duration</span><select defaultValue="2"><option value="1">1 hour</option><option value="2">2 hours</option><option value="3">3 hours</option><option value="5">5 hours</option></select></label> : null}
            {'trainingRequired' in selected && selected.trainingRequired ? <p className="form-notice"><ShieldAlert aria-hidden="true" /> This equipment requires a current certification before checkout.</p> : null}
            <button className="button button--primary button--wide" type="submit"><CalendarDays aria-hidden="true" /> Request reservation</button>
            <p className="form-caption"><Sparkles aria-hidden="true" /> Prototype only—no payment or real booking will be created.</p>
          </form>
        ) : null}
      </Modal>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function rotate<T>(items: T[], offset: number) {
  if (!items.length) return items;
  const normalized = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

function CarouselButtons({ label, onPrevious, onNext }: { label: string; onPrevious: () => void; onNext: () => void }) {
  return (
    <div className="carousel-buttons">
      <button className="icon-button" onClick={onPrevious} aria-label={'Show previous ' + label}><ArrowLeft aria-hidden="true" /></button>
      <button className="icon-button" onClick={onNext} aria-label={'Show next ' + label}><ArrowRight aria-hidden="true" /></button>
    </div>
  );
}
