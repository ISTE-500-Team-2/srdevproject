import { CircleAlert, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { unreachableMessage } from '../lib/api';

/** Seconds before each automatic attempt: quick at first, then every half minute. */
export const retryDelays = [5, 10, 20, 30];
/** An attempt with no answer by then is replaced by a fresh one rather than awaited. */
export const stalledAfterMs = 15_000;
const delayAfter = (attempts: number) => retryDelays[Math.min(attempts, retryDelays.length - 1)];
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Shown in place of a page whose account check failed. It tries again on its own,
 * backing off, while the tab is visible, and at once when the browser comes back
 * online, so an unattended screen (front desk, reader) recovers by itself.
 * The countdown is not a live region: screen readers hear the alert once, not every tick.
 * As a `banner` it sits over a page that stays open (a check failed in the background),
 * retrying the same way without taking the page or anything typed into it away.
 */
export function ServerUnreachable({ message, retrying, onRetry, banner = false }: {
  message: string;
  retrying: boolean;
  onRetry: (supersede?: boolean) => void;
  banner?: boolean;
}) {
  const [attempts, setAttempts] = useState(0);
  const [remaining, setRemaining] = useState(retryDelays[0]);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const retryNow = (supersede = false) => {
    if (retrying && !supersede) return;
    const next = attempts + 1;
    setAttempts(next);
    setRemaining(delayAfter(next));
    onRetry(supersede);
  };
  const latest = useRef(retryNow);
  useEffect(() => { latest.current = retryNow; });

  useEffect(() => {
    if (retrying || hidden) return;
    const timer = window.setTimeout(() => {
      if (remaining > 1) setRemaining(remaining - 1);
      else latest.current();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, retrying, hidden]);

  useEffect(() => {
    if (!retrying || hidden) return;
    const timer = window.setTimeout(() => latest.current(true), stalledAfterMs);
    return () => window.clearTimeout(timer);
  }, [retrying, hidden, attempts]);

  useEffect(() => {
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    const online = () => latest.current(true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
    };
  }, []);

  const unreachable = message === unreachableMessage;
  const status = retrying ? 'Checking the connection…' : <>Trying again in <b>{clock(remaining)}</b></>;
  if (banner) return <section className="connection-banner" aria-label="Connection status">
    {unreachable ? <WifiOff aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
    <div>
      <p role="alert">
        <strong>{unreachable ? 'Connection lost.' : 'Your account didn’t refresh.'}</strong>
        {' '}{unreachable ? '' : `${message} `}This page stays open, and anything you’ve typed is kept.
      </p>
      <p className="connection-banner__status">{status}</p>
    </div>
    <button className="button" type="button" disabled={retrying} onClick={() => retryNow()}>
      {retrying ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
      {retrying ? 'Trying again…' : 'Try again'}
    </button>
  </section>;
  return <section className="server-unreachable" aria-labelledby="server-unreachable-title">
    <img className="server-unreachable__logo" src="/assets/collaboratory-logo.webp" alt="The Collaboratory" />
    <div role="alert">
      <div className="reset-medallion" aria-hidden="true">{unreachable ? <WifiOff /> : <CircleAlert />}</div>
      <p className="eyebrow">{unreachable ? 'Connection lost' : 'Something went wrong'}</p>
      <h1 id="server-unreachable-title">{unreachable ? 'We can’t reach the server' : 'Your account didn’t load'}</h1>
      <p className="server-unreachable__lede">
        {unreachable ? 'This is usually a brief network hiccup.' : message}
        {' '}We’ll keep trying in the background, or you can try again now.
      </p>
    </div>
    <button className="button button--primary" type="button" disabled={retrying} onClick={() => retryNow()}>
      {retrying ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
      {retrying ? 'Trying again…' : 'Try again'}
    </button>
    <p className="server-unreachable__status">{status}</p>
    <p className="server-unreachable__help">Still not working? Check your internet connection, or let a staff member know.</p>
  </section>;
}
