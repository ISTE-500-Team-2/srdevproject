import { dateTime, shortDate, timeOnly } from "../lib/display";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  FileCheck2,
  LogIn,
  LogOut,
  X,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useApi } from '../lib/useApi';
import type {
  Overview,
  Reservation,
  SponsorRequest,
  SupervisedMinors,
  SupervisionSummary,
  Waiver,
} from '../lib/contracts';
import { Toast } from '../components/Toast';
import { MemberBadge } from '../components/MemberBadge';

// GSAP is only needed for the greeting, so it loads with it.
const SplitText = lazy(() => import('../components/reactbits/SplitText'));
import StatusMark from '../components/reactbits/StatusMark';

/** The greeting animates once per browser session, then stays still. */
function useFirstVisit(key: string) {
  const first = useRef(!sessionStorage.getItem(key));
  useEffect(() => sessionStorage.setItem(key, '1'), [key]);
  return first.current;
}

const names = (list: string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(list);
const firstName = (name: string) => name.split(' ')[0] ?? name;

export function MemberHomePage() {
  const { user, notification, clearNotification, refresh } = useAuth();
  const overview = useApi<Overview>('/me/overview');
  const waivers = useApi<Waiver[]>('/me/waivers');
  const bookings = useApi<Reservation[]>('/reservations');
  const greet = useFirstVisit('collaboratory:greeted');
  const [toast, setToast] = useState<string | null>(null);
  // Visit and sponsor state feed the Check-in card and access band. If the
  // request fails, both simply show their usual state.
  const supervision = useApi<SupervisionSummary>('/me/supervision', {
    refreshInterval: 15000,
    retainOnReload: true,
  });
  const isMinor = supervision.data?.isMinor ?? user?.isMinor ?? false;
  const minors = useApi<SupervisedMinors>(user?.isMinor === false ? '/me/minors' : null, {
    refreshInterval: 15000,
    retainOnReload: true,
  });
  const visit = supervision.data?.visit ?? null;
  const sponsorName = supervision.data?.sponsor?.name ?? user?.sponsorName ?? null;
  const linked = minors.data?.minors ?? [];
  const supervising = linked.filter((m) => m.visit);
  const requests = isMinor ? (supervision.data?.pendingRequests ?? []) : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [visitError, setVisitError] = useState('');
  const [requestError, setRequestError] = useState('');
  const summary = overview.data;
  const pending = waivers.data?.filter((w) => w.scope !== 'equipment' && !w.signed) ?? [];
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
  const checkOut = async () => {
    setBusy('check-out');
    setVisitError('');
    try {
      await api('/me/visit/check-out', { method: 'POST', body: {} });
      supervision.reload();
      minors.reload();
      overview.reload();
      setToast('You’re checked out. See you next time.');
    } catch (err) {
      setVisitError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const answer = async (request: SponsorRequest, choice: 'accept' | 'decline') => {
    setBusy(`${choice}-${request.id}`);
    setRequestError('');
    try {
      await api(`/me/sponsor-requests/${request.id}/${choice}`, { method: 'POST', body: {} });
      supervision.reload();
      if (choice === 'accept') {
        // The session carries the sponsor name the badge falls back to.
        void refresh();
        setToast(`${request.adultName} is now your sponsoring adult.`);
      } else setToast(`Request from ${request.adultName} declined.`);
    } catch (err) {
      setRequestError(errorMessage(err));
    } finally {
      setBusy(null);
    }
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
                      : 'All facility policies are signed.'}
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
                  status={visit || summary.canCheckIn ? 'done' : 'failed'}
                  strike={false}
                  size={20}
                  color="#a86008"
                  doneColor="#1f6b32"
                  errorColor="#b73a2e"
                  label={
                    visit
                      ? isMinor && sponsorName
                        ? `You’re checked in with ${sponsorName}.`
                        : supervising.length
                          ? `You’re checked in, supervising ${names(supervising.map((m) => m.name))}.`
                          : 'You’re checked in.'
                      : summary.canCheckIn
                        ? 'You can check in.'
                        : summary.reasons.map((r) => r.replace(/\.$/, '')).join('. ') + '.'
                  }
                />
              </p>
              {visit ? (
                <p className="check-in__last">
                  <span>Checked in</span>
                  <b>
                    Since {timeOnly(visit.checkedInAt)}
                    {visit.buildingName ? ` · ${visit.buildingName}` : ''}
                  </b>
                </p>
              ) : last ? (
                <p className="check-in__last">
                  <span>Last check-in</span>
                  <b>
                    {dateTime(last.checkedInAt)} · {last.location}
                  </b>
                  <small>{last.method === 'nfc' ? 'With your NFC tag' : 'From this site'}</small>
                </p>
              ) : summary.canCheckIn ? (
                <p className="summary-card__note">No check-ins yet.</p>
              ) : null}
              {!visit && summary.recentCheckIns.length > 1 ? (
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
              {visit ? (
                <>
                  <p className="check-in__fallback">
                    {isMinor && sponsorName
                      ? `Your visit ends when ${firstName(sponsorName)} checks out.`
                      : supervising.length === 1
                        ? `Checking out also ends ${firstName(supervising[0]!.name)}’s visit.`
                        : supervising.length
                          ? `Checking out also ends visits for ${names(supervising.map((m) => firstName(m.name)))}.`
                          : 'Check out when you leave so staff know who’s here.'}
                  </p>
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={busy !== null}
                    onClick={() => void checkOut()}
                  >
                    <LogOut aria-hidden="true" /> {busy === 'check-out' ? 'Checking out…' : 'Check out'}
                  </button>
                  {visitError ? (
                    <p role="alert" className="form-error">
                      {visitError}
                    </p>
                  ) : null}
                </>
              ) : summary.canCheckIn ? (
                // Being eligible is not presence: the reader or staff check people in.
                <p className="check-in__fallback">Tap your NFC tag at the door. Forgot it? Ask staff.</p>
              ) : fix ? (
                // Blocked: point at what unblocks it.
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
              <div className="access-band__pills">
                <span className="membership-card__tier">{accessLabel}</span>
                {isMinor ? (
                  <span className="status-pill status-pill--warn">
                    {supervision.data?.marker ?? 'Under 18'}
                  </span>
                ) : null}
              </div>
              {user ? (
                <p>
                  {user.firstName} {user.lastName} · Member ID {String(user.id).padStart(6, '0')}
                </p>
              ) : null}
              {isMinor ? (
                sponsorName ? (
                  <p>
                    Sponsoring adult <b>{sponsorName}</b>
                  </p>
                ) : requests.length ? null : (
                  <p>No sponsoring adult linked yet. A parent or guardian can send a request from their profile.</p>
                )
              ) : linked.length ? (
                <p>
                  Supervising <b>{names(linked.map((m) => m.name))}</b>
                </p>
              ) : null}
              {requests.map((request) => (
                <div key={request.id} className="access-band__request">
                  <p>
                    <b>{request.adultName}</b> asked to be your sponsoring adult. You’ll visit
                    together and they check out for you both.
                  </p>
                  <div className="access-band__pills">
                    <button
                      type="button"
                      className="button"
                      disabled={busy !== null}
                      onClick={() => void answer(request, 'accept')}
                      aria-label={`Accept request from ${request.adultName}`}
                    >
                      <Check aria-hidden="true" /> {busy === `accept-${request.id}` ? 'Accepting…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy !== null}
                      onClick={() => void answer(request, 'decline')}
                      aria-label={`Decline request from ${request.adultName}`}
                    >
                      <X aria-hidden="true" /> {busy === `decline-${request.id}` ? 'Declining…' : 'Decline'}
                    </button>
                  </div>
                </div>
              ))}
              {requestError ? (
                <p role="alert" className="form-error">
                  {requestError}
                </p>
              ) : null}
              <Link to="/membership">
                Membership & payment records <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
            {user ? (
              <MemberBadge
                isMinor={isMinor}
                sponsorName={sponsorName}
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
