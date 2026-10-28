import { dateTime, shortDate, timeOnly } from "../lib/display";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  FileCheck2,
  LogIn,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useApi } from '../lib/useApi';
import type { Overview, Reservation, Waiver } from '../lib/contracts';
import { Toast } from '../components/Toast';
import { MemberBadge } from '../components/MemberBadge';
import { SiteSlideCommit } from '../components/SiteSlideCommit';
// GSAP is only needed for the greeting, so it loads with it.
const SplitText = lazy(() => import('../components/reactbits/SplitText'));
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
  const waivers = useApi<Waiver[]>('/me/waivers');
  const bookings = useApi<Reservation[]>('/reservations');
  const [error, setError] = useState('');
  const greet = useFirstVisit('collaboratory:greeted');
  const [toast, setToast] = useState<string | null>(null);
  const summary = overview.data;
  const pending = waivers.data?.filter((w) => !w.signed) ?? [];
  const [now] = useState(() => Date.now());
  const upcoming = (bookings.data ?? [])
    .filter((r) => r.status !== 'cancelled' && new Date(r.endTime).getTime() > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const last = summary?.recentCheckIns[0];
  // The server's reasons are fixed sentences; link the first one that has a fix.
  const fix = summary?.reasons
    .map((reason) =>
      /waiver|polic(y|ies) .*signature/i.test(reason)
        ? { to: '/certifications', label: 'Review and sign' }
        : /membership or day pass/i.test(reason)
          ? { to: '/membership', label: 'Get a membership or pass' }
          : /reservation/i.test(reason)
            ? { to: '/equipment', label: 'Book equipment' }
            : null,
    )
    .find(Boolean);
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
    bookings.reload();
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
            <Suspense fallback={<h1>Welcome back, {user.firstName}</h1>}>
              <SplitText
                tag="h1"
                text={`Welcome back, ${user.firstName}`}
                textAlign="left"
                trigger="load"
                delay={30}
                duration={0.9}
              />
            </Suspense>
          ) : (
            <h1>Welcome back, {user?.firstName}</h1>
          )}
        </div>
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
            <article className="summary-card">
              <div className="summary-card__heading">
                <span className="summary-card__icon">
                  <FileCheck2 aria-hidden="true" />
                </span>
                <h2>Waivers</h2>
                <strong>{summary.pendingWaivers || ''}</strong>
              </div>
              {pending.length ? (
                <ul className="summary-card__list">
                  {pending.slice(0, 3).map((w) => (
                    <li key={w.id}>
                      <b>{w.name}</b>
                      <span>
                        {w.expiredSignature
                          ? 'Signature expired'
                          : w.outdatedSignature
                            ? 'New version to sign'
                            : 'Not signed yet'}
                      </span>
                    </li>
                  ))}
                  {pending.length > 3 ? <li>+{pending.length - 3} more</li> : null}
                </ul>
              ) : (
                <p className="summary-card__note">
                  {summary.pendingWaivers
                    ? `${summary.pendingWaivers} waiting for your signature.`
                    : 'Everything is signed.'}
                </p>
              )}
              <Link to="/certifications" className="summary-card__action">
                <span>{summary.pendingWaivers ? 'Review and sign' : 'View your waivers'}</span>
                <ChevronRight aria-hidden="true" />
              </Link>
            </article>

            <article className="summary-card">
              <div className="summary-card__heading">
                <span className="summary-card__icon">
                  <CalendarDays aria-hidden="true" />
                </span>
                <h2>Reservations</h2>
                <strong>{summary.activeReservations || ''}</strong>
              </div>
              {upcoming.length ? (
                <ul className="summary-card__list">
                  {upcoming.slice(0, 2).map((r) => (
                    <li key={r.id}>
                      <b>{r.equipmentName}</b>
                      <span>
                        {shortDate(r.startTime)} · {timeOnly(r.startTime)}–{timeOnly(r.endTime)}
                      </span>
                    </li>
                  ))}
                  {upcoming.length > 2 ? <li>+{upcoming.length - 2} more</li> : null}
                </ul>
              ) : (
                <p className="summary-card__note">Nothing booked yet.</p>
              )}
              <Link to="/equipment" className="summary-card__action">
                <span>{upcoming.length ? 'Book or manage equipment' : 'Book equipment'}</span>
                <ChevronRight aria-hidden="true" />
              </Link>
            </article>

            <article className="summary-card">
              <div className="summary-card__heading">
                <span className="summary-card__icon">
                  <LogIn aria-hidden="true" />
                </span>
                <h2>Check-in</h2>
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
                      ? 'You can check in.'
                      : summary.reasons.map((r) => r.replace(/\.$/, '')).join('. ') + '.'
                  }
                />
              </p>
              {last ? (
                <p className="check-in__last">
                  <span>Last check-in</span>
                  <b>
                    {dateTime(last.checkedInAt)} · {last.location}
                  </b>
                  <small>{last.method === 'nfc' ? 'With your NFC tag' : 'From this site'}</small>
                </p>
              ) : summary.canCheckIn ? (
                <p className="summary-card__note">No check-ins yet. Tap your NFC tag at the door.</p>
              ) : null}
              {summary.recentCheckIns.length > 1 ? (
                <details className="check-in__history">
                  <summary>Earlier check-ins</summary>
                  <ul>
                    {summary.recentCheckIns.slice(1).map((item) => (
                      <li key={item.id}>
                        {dateTime(item.checkedInAt)} · {item.location}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {summary.canCheckIn ? (
                <>
                  <p className="check-in__fallback">Forgot your tag?</p>
                  <SiteSlideCommit
                    label="Slide to check in"
                    doneLabel="Checked in"
                    errorLabel="Couldn't check in"
                    onConfirm={checkIn}
                  />
                </>
              ) : fix ? (
                // A disabled slider is a dead end; point at what unblocks it.
                <Link to={fix.to} className="summary-card__action">
                  <span>{fix.label}</span>
                  <ChevronRight aria-hidden="true" />
                </Link>
              ) : null}
            </article>
          </div>
          <aside className="membership-card access-band">
            <div className="access-band__info">
              <div className="membership-card__heading">Your access</div>
              <span className="membership-card__tier">{accessLabel}</span>
              {user ? (
                <p>
                  {user.firstName} {user.lastName} · Member ID {String(user.id).padStart(6, '0')}
                </p>
              ) : null}
              <Link to="/membership">
                Membership & payment records <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
            {user ? (
              <MemberBadge
                name={`${user.firstName} ${user.lastName}`}
                access={accessLabel}
                memberId={user.id}
              />
            ) : null}
          </aside>
        </section>
      ) : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
