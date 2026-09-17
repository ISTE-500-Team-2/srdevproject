import {
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  FileCheck2,
  LogIn,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useApi } from '../lib/useApi';
import type { LiveEquipment, Overview } from '../lib/contracts';
import { Toast } from '../components/Toast';

export function MemberHomePage() {
  const { user } = useAuth();
  const overview = useApi<Overview>('/me/overview');
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const summary = overview.data;
  const accessLabel = summary?.entitlement.membership
    ? 'Active membership'
    : summary?.entitlement.dayPass
      ? 'Day pass active'
      : 'No active access';
  const checkIn = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/me/check-ins', {
        method: 'POST',
        body: { location: 'Collaboratory member portal' },
      });
      overview.reload();
      setToast('Check-in saved. Welcome to the Collaboratory!');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="member-home page-enter">
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Member dashboard</p>
          <h1>Welcome back, {user?.firstName}</h1>
        </div>
        {summary ? (
          <span className="membership-pill">{accessLabel}</span>
        ) : null}
      </section>
      {overview.loading ? <p role="status">Loading account activity…</p> : null}
      {overview.error ? (
        <p role="alert" className="form-error">
          {overview.error} <button onClick={overview.reload}>Retry</button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {summary ? (
        <section className="member-summary" aria-label="Account summary">
          <div className="member-summary__cards">
            {[
              {
                title: 'Pending waivers',
                count: summary.pendingWaivers,
                to: '/certifications',
                prompt: 'Review your policies',
                Icon: FileCheck2,
              },
              {
                title: 'Active reservations',
                count: summary.activeReservations,
                to: '/reservations',
                prompt: 'Manage your bookings',
                Icon: CalendarDays,
              },
            ].map(({ title, count, to, prompt, Icon }) => (
              <article className="summary-card" key={title}>
                <div className="summary-card__heading">
                  <span className="summary-card__icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <h2>{title}</h2>
                  <strong>{count}</strong>
                </div>
                <Link to={to} className="summary-card__action">
                  <span>{prompt}</span>
                  <ChevronRight aria-hidden="true" />
                </Link>
              </article>
            ))}
            <article className="summary-card">
              <h2>Visit check-in</h2>
              <p>
                {summary.canCheckIn
                  ? 'Your access and required waivers are current.'
                  : summary.reasons.join('. ') + '.'}
              </p>
              <button
                className="button button--primary"
                onClick={() => void checkIn()}
                disabled={busy || !summary.canCheckIn}
              >
                <LogIn aria-hidden="true" />
                {busy ? 'Checking…' : 'Check in'}
              </button>
            </article>
          </div>
          <aside className="membership-card">
            <div className="membership-card__heading">Your access</div>
            <span className="membership-card__tier">{accessLabel}</span>
            <hr />
            <p>
              Equipment eligibility is checked against your membership or day
              pass, certifications, and required waivers.
            </p>
            <Link to="/membership">
              Membership & payment records <ArrowUpRight aria-hidden="true" />
            </Link>
          </aside>
        </section>
      ) : null}
      <div className="dashboard-divider" />
      <section>
        <div className="discovery-heading">
          <h2>Equipment</h2>
          <Link to="/reservations">
            View all equipment <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
        {catalog.loading ? <p role="status">Loading equipment…</p> : null}
        {catalog.error ? (
          <p role="alert">
            {catalog.error} <button onClick={catalog.reload}>Retry</button>
          </p>
        ) : null}
        <div className="equipment-preview-grid">
          {catalog.data?.slice(0, 3).map((item) => (
            <article className="equipment-preview" key={item.id}>
              <div className="equipment-preview__image">
                <img src={item.image} alt={item.name} />
              </div>
              <div className="equipment-preview__body">
                <div>
                  <p className="eyebrow">{item.type}</p>
                  <h3>{item.name}</h3>
                </div>
                <small>{item.availability}</small>
              </div>
              <Link to="/reservations">
                Choose a time <ChevronRight aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
        {!catalog.loading && !catalog.error && !catalog.data?.length ? (
          <p className="empty-state">No equipment is listed yet.</p>
        ) : null}
      </section>
      <section className="panel feature-notice">
        <h2>Recent check-ins</h2>
        {summary?.recentCheckIns.length ? (
          <ul>
            {summary.recentCheckIns.map((item) => (
              <li key={item.id}>
                {new Date(item.checkedInAt).toLocaleString()} · {item.location}
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent check-ins.</p>
        )}
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
