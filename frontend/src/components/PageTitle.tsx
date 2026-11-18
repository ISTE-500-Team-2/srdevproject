import { useEffect, type ReactNode } from 'react';

export const SITE_TITLE = 'The Collaboratory';

/** How long after a page change its name is read out: after any menu or dialog that led there has closed. */
export const ANNOUNCE_DELAY_MS = 150;

let currentTitle: string | null = null;
let announcer: HTMLElement | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;

/** A polite live region of its own, so it is in place before the first page change. */
function liveRegion() {
  if (announcer?.isConnected) return announcer;
  announcer = document.createElement('p');
  announcer.className = 'sr-only';
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  announcer.dataset.routeAnnouncer = '';
  document.body.append(announcer);
  return announcer;
}

/**
 * Names the browser tab after the current page, and tells screen readers when another page opens:
 * moving between pages in the app changes no document, so nothing else announces it. The first
 * page is not announced (the browser does that), nor is a change within a page that keeps its title.
 */
export function PageTitle({ title }: { title?: string }) {
  useEffect(() => {
    const full = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
    document.title = full;
    const region = liveRegion();
    const previous = currentTitle;
    currentTitle = full;
    if (previous === null || previous === full) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      region.textContent = full;
    }, ANNOUNCE_DELAY_MS);
  }, [title]);
  return null;
}

/** Each page names its browser tab, e.g. "Membership · The Collaboratory". */
export const titled = (title: string, page: ReactNode) => <><PageTitle title={title} />{page}</>;
