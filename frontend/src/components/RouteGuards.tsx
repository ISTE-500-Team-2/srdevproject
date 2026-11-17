// Client navigation guards refresh session state before admitting protected pages; the API
// independently authorizes every request.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { loginPath } from '../lib/returnPath';
import { PageTitle } from './PageTitle';
import { ServerUnreachable } from './ServerUnreachable';

/**
 * Arriving at protected pages waits for a session check, so a deep link never
 * shows private pages before the session is known. After that, each navigation
 * and tab return rechecks in the background: the page frame stays mounted (no
 * blank screen, reset sidebar or lost form between pages), and a revoked
 * session or role is removed as soon as the server answers.
 */
export function RequireUser() {
  const { user, loading, error, refresh, signedOut } = useAuth();
  const location = useLocation();
  const [arrived, setArrived] = useState(false);
  const arrivedRef = useRef(false);
  // While the failure page is up, every new attempt is a blocking check: a background
  // one clears the error first and, with no user yet, would send the person to sign in.
  const [retrying, setRetrying] = useState(false);
  const [shownError, setShownError] = useState('');
  const failed = useRef(false);
  const retryingNow = useRef(false);
  // A retry owns the page only until a newer attempt starts; a superseded read may
  // never settle, so its outcome must not be awaited.
  const retryTurn = useRef(0);
  const releaseRetry = useCallback(() => {
    retryTurn.current++;
    retryingNow.current = false;
    setRetrying(false);
  }, []);
  useEffect(() => {
    failed.current = !!error;
    if (error) setShownError(error);
  }, [error]);
  // `supersede` starts a fresh attempt even while one is pending: a stalled read has
  // no timeout, so a navigation, tab return or reconnect must not wait on it.
  const retry = useCallback(async (supersede = false) => {
    if (retryingNow.current && !supersede) return;
    const turn = ++retryTurn.current;
    retryingNow.current = true;
    setRetrying(true);
    try { await refresh(true, { fresh: true }); } finally {
      if (retryTurn.current === turn) releaseRetry();
    }
  }, [refresh, releaseRetry]);
  const outage = () => failed.current || retryingNow.current;
  useEffect(() => {
    // Every location gets its own read; an older location's read is never reused.
    if (arrivedRef.current) {
      if (outage()) void retry(true);
      else void refresh();
      return;
    }
    let active = true;
    void refresh(true).then(() => {
      if (!active) return;
      arrivedRef.current = true;
      setArrived(true);
    });
    return () => { active = false; };
  }, [location, refresh, retry]);
  useEffect(() => {
    // Each return revalidates anew (never joins an older, possibly stalled read).
    const resume = () => {
      if (outage()) void retry(true);
      else void refresh(false, { fresh: true });
    };
    const visible = () => { if (document.visibilityState === 'visible') resume(); };
    // pageshow also fires on every ordinary load; only a back/forward-cache
    // restoration brings back a page whose session may have changed.
    const restored = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, retry]);
  const unreachable = <main className="page-shell">
    <ServerUnreachable message={error || shownError} retrying={retrying} onRetry={(supersede) => void retry(supersede)} />
  </main>;
  if (retrying) return unreachable;
  if (loading || !arrived)
    return <main className="page-shell" role="status">Loading your account…</main>;
  if (error) return unreachable;
  // Remember the requested page so signing in lands there, not on home. Not after
  // a deliberate sign-out: the next person at a shared computer starts fresh.
  if (user) return <Outlet />;
  return <Navigate to={signedOut ? '/login' : loginPath(location)} replace />;
}

export const isWorkspaceUser = (user: { roles: string[] } | null | undefined) =>
  !!user?.roles.some(role => role === 'staff' || role === 'admin');

/**
 * Staff and admins share the workspace; admin-only mutations stay server-enforced.
 * While a member's account is open, the signed-in staff member is the actor.
 */
export function RequireStaff() {
  const { user, actor } = useAuth();
  if (isWorkspaceUser(actor ?? user)) return <Outlet />;
  return <section aria-labelledby="access-denied-title">
    <PageTitle title="Access denied" />
    <h1 id="access-denied-title">Access denied</h1>
    <p>This page is available to staff and administrators only.</p>
    <Link className="button" to="/">Return to home</Link>
  </section>;
}
