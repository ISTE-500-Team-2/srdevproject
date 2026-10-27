import { dateTime } from "../lib/display";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  FileCheck2,
  LogIn,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useApi } from '../lib/useApi';
import type { LiveEquipment, Overview } from '../lib/contracts';
import { Toast } from '../components/Toast';
import { MemberBadge } from '../components/MemberBadge';
import { SiteSlideCommit } from '../components/SiteSlideCommit';
import SplitText from '../components/reactbits/SplitText';
import StatusMark from '../components/reactbits/StatusMark';

/** The greeting animates once per browser session, then stays still. */
function useFirstVisit(key: string) {
  const first = useRef(!sessionStorage.getItem(key));
  useEffect(() => sessionStorage.setItem(key, '1'), [key]);
  return first.current;
}

export function MemberHomePage() {
  const { user, notification, clearNotification } = useAuth();
  const overview = useApi<Overview>('/me/overview');
  const catalog = useApi<LiveEquipment[]>('/equipment');
  const [error, setError] = useState('');
  const greet = useFirstVisit('collaboratory:greeted');
  const [toast, setToast] = useState<string | null>(null);
  const summary = overview.data;
  const accessLabel = summary?.entitlement.membership
    ? 'Active membership'
    : summary?.entitlement.dayPass
      ? 'Day pass active'
      : 'No active access';
  // Returns the request so the slider can show its own pending, done and
  // failed states; a rejection shakes it back and the reason shows below.
  const checkIn = async () => {
    setError('');
    try {
      await api('/me/check-ins', {
        method: 'POST',
        body: {},
      });
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    }
    overview.reload();
    setToast('Check-in saved. Welcome to the Collaboratory!');
  };
  useEffect(() => {
    if (!notification) return;
    setToast(notification.subject);
    clearNotification();
  }, [clearNotification, notification]);
  return (
    <div className="member-home page-enter">
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Member dashboard</p>
          {greet && user ? (
            <SplitText
              tag="h1"
              text={`Welcome back, ${user.firstName}`}
              textAlign="left"
              trigger="load"
              delay={30}
              duration={0.9}
            />
          ) : (
            <h1>Welcome back, {user?.firstName}</h1>
          )}
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
                to: '/equipment',
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
              <div className="summary-card__heading">
                <span className="summary-card__icon">
                  <LogIn aria-hidden="true" />
                </span>
                <h2>Visit check-in</h2>
              </div>
              <p className="check-in__status">
                <StatusMark
                  status={summary.canCheckIn ? 'done' : 'failed'}
                  strike={false}
                  size={20}
                  color="#a86008"
                  doneColor="#1f6b32"
                  errorColor="#b73a2e"
                  label={
                    summary.canCheckIn
                      ? 'Your access and required waivers are current.'
                      : summary.reasons.join('. ') + '.'
                  }
                />
              </p>
              <SiteSlideCommit
                label="Slide to check in"
                doneLabel="Checked in"
                errorLabel="Couldn't check in"
                disabled={!summary.canCheckIn}
                onConfirm={checkIn}
              />
            </article>
          </div>
          <aside className="membership-card">
            <div className="membership-card__heading">Your access</div>
            <span className="membership-card__tier">{accessLabel}</span>
            {user ? (
              <MemberBadge
                name={`${user.firstName} ${user.lastName}`}
                access={accessLabel}
                memberId={user.id}
              />
            ) : null}
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
          <Link to="/equipment">
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
              <Link to="/equipment">
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
                {dateTime(item.checkedInAt)} · {item.location}
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
