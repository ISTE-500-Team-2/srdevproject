import { ArrowUpRight, CalendarDays, ChevronRight, FileCheck2, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { classes, equipment } from '../data/mockData';

const summaries = [
  { title: 'Pending waivers', icon: FileCheck2, body: 'No pending waivers', prompt: 'You’re all set!', to: '/certifications' },
  { title: 'Active reservations', icon: CalendarDays, body: 'No active reservations', prompt: 'Start creating', to: '/reservations' },
  { title: 'Upcoming classes', icon: ShieldCheck, body: 'No upcoming classes', prompt: 'Sign up now', to: '/classes' },
];

export function MemberHomePage() {
  const { user } = useAuth();

  return (
    <div className="member-home page-enter">
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Member dashboard</p>
          <h1>Welcome back, {user?.firstName ?? 'John'}</h1>
        </div>
        <span className="membership-pill">Monthly Member</span>
      </section>

      <section className="member-summary" aria-label="Account summary">
        <div className="member-summary__cards">
          {summaries.map((card) => {
            const Icon = card.icon;
            return (
              <article className="summary-card" key={card.title}>
                <div className="summary-card__heading">
                  <span className="summary-card__icon"><Icon aria-hidden="true" /></span>
                  <h2>{card.title}</h2>
                  <strong>0</strong>
                </div>
                <Link to={card.to} className="summary-card__action">
                  <span><strong>{card.body}</strong><em>{card.prompt}</em></span>
                  <ChevronRight aria-hidden="true" />
                </Link>
              </article>
            );
          })}
        </div>

        <aside className="membership-card">
          <div className="membership-card__glow" aria-hidden="true" />
          <div className="membership-card__heading"><Sparkles aria-hidden="true" /><span>Your membership perks</span></div>
          <span className="membership-card__tier">Monthly</span>
          <hr />
          <strong>Free use of basic tools</strong>
          <ul><li>3D Printer</li><li>Laser Engraver</li><li>And more!</li></ul>
          <Link to="/profile">Manage your membership <ArrowUpRight aria-hidden="true" /></Link>
        </aside>
      </section>

      <div className="dashboard-divider" />

      <section className="discovery-grid">
        <ClassDiscovery />
        <EquipmentDiscovery />
      </section>
    </div>
  );
}

function ClassDiscovery() {
  return (
    <div>
      <div className="discovery-heading">
        <h2>Most Popular Classes</h2>
        <Link to="/classes">View all classes <ArrowUpRight aria-hidden="true" /></Link>
      </div>
      <div className="class-card-grid">
        {classes.slice(0, 2).map((item) => (
          <article className="class-card" key={item.id}>
            <div className="class-card__image">
              <img src={item.image} alt="" />
              <span>{item.enrolled} / {item.capacity} slots</span>
            </div>
            <div className="class-card__body">
              <div><h3>{item.title}</h3><p>{item.description}</p></div>
              <time>{item.date}<small>{item.time}</small></time>
            </div>
            <Link to="/classes" aria-label={'View ' + item.title}>
              View class <ChevronRight aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}

function EquipmentDiscovery() {
  return (
    <div>
      <div className="discovery-heading">
        <h2>Try Something New! <RefreshCw aria-hidden="true" /></h2>
        <Link to="/reservations">Check out all equipment <ArrowUpRight aria-hidden="true" /></Link>
      </div>
      <div className="equipment-preview-grid">
        {equipment.slice(1, 3).map((item) => (
          <article className="equipment-preview" key={item.id}>
            <div className="equipment-preview__image">
              <img src={item.image} alt={item.name + ' ' + item.type} />
            </div>
            <div className="equipment-preview__body">
              <div><p className="eyebrow">{item.type}</p><h3>{item.name}</h3></div>
              <div>
                <span>{item.trainingRequired ? 'Training required' : 'Member ready'}</span>
                <strong>${item.rate.toFixed(2)}/hour</strong>
              </div>
            </div>
            <Link to="/reservations" aria-label={'Reserve ' + item.name}>
              Reserve <ChevronRight aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}
