// Keeps an unexpected error, or page code that went missing after a release, from blanking the
// site: the page shows a message and a Reload button instead, and reloads once on its own when its
// code is gone.

import { CircleAlert, RefreshCw } from 'lucide-react';
import { Component, useId, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

const missingCodePattern =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Lazily loaded page code failed to download, usually because a release replaced it. */
export function isChunkLoadError(error: unknown) {
  return error instanceof Error && (error.name === 'ChunkLoadError' || missingCodePattern.test(error.message));
}

/** Reloads go through here so tests can watch them (jsdom cannot navigate). */
export const browser = { reload: () => window.location.reload() };

const reloadedAtKey = 'collaboratory:reloaded-for-release';

/**
 * Reloads to fetch the current release, once: if code is still missing within a minute (a broken
 * release), the message stays rather than reloading in a loop. Without storage there is no way to
 * tell, so it never reloads on its own. Offline, the code is missing because the network is: a
 * reload would only swap the message for the browser's own offline page, so it waits for the
 * Reload button.
 */
export function reloadForRelease(now = Date.now()) {
  if (navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(reloadedAtKey));
    if (last && now - last < 60_000) return false;
    sessionStorage.setItem(reloadedAtKey, String(now));
  } catch {
    return false;
  }
  browser.reload();
  return true;
}

type BoundaryProps = { children: ReactNode; resetKey: string; standalone: boolean };
type BoundaryState = { failed: boolean; missingCode: boolean; reloading: boolean; resetKey: string };

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, missingCode: false, reloading: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, missingCode: isChunkLoadError(error) };
  }

  /** Going to another page tries again there. */
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, missingCode: false, reloading: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error) && reloadForRelease()) this.setState({ reloading: true });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const message = <PageError missingCode={this.state.missingCode} reloading={this.state.reloading} standalone={this.props.standalone} />;
    return this.props.standalone ? <main className="page-shell">{message}</main> : message;
  }
}

/** Shares the look of the server-unreachable page. */
function PageError({ missingCode, reloading, standalone }: { missingCode: boolean; reloading: boolean; standalone: boolean }) {
  const titleId = useId();
  return (
    <section className="server-unreachable" aria-labelledby={titleId}>
      {standalone ? <img className="server-unreachable__logo" src="/assets/collaboratory-logo.webp" alt="The Collaboratory" /> : null}
      <div role="alert">
        <div className="reset-medallion" aria-hidden="true">{missingCode ? <RefreshCw /> : <CircleAlert />}</div>
        <p className="eyebrow">{missingCode ? 'Site updated' : 'Something went wrong'}</p>
        <h1 id={titleId}>{missingCode ? 'Reload for the latest version' : 'This page didn’t load'}</h1>
        <p className="server-unreachable__lede">
          {missingCode
            ? 'Part of this page couldn’t load, usually because the site was updated while it was open.'
            : 'Something unexpected stopped this page from showing. Reloading usually fixes it.'}
        </p>
      </div>
      <button className="button button--primary" type="button" disabled={reloading} onClick={() => browser.reload()}>
        <RefreshCw aria-hidden="true" /> {reloading ? 'Reloading…' : 'Reload'}
      </button>
      <p className="server-unreachable__help">Still not working? Check your internet connection, or let a staff member know.</p>
    </section>
  );
}

/**
 * Catches errors from the pages inside it. `standalone` is for content with no site frame around it:
 * the message brings its own main landmark and logo.
 */
export function PageErrorBoundary({ children, standalone = false }: { children: ReactNode; standalone?: boolean }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname} standalone={standalone}>{children}</Boundary>;
}
