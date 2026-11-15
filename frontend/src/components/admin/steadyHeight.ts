// Keeps the workspace column from collapsing between staff pages, and between views of one page.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Loading UI marks itself with this (LoadState, Skeleton). */
const LOADING = "[data-loading]";
/** How long content must show no loading UI before a shorter page counts as settled. */
export const SETTLE_MS = 250;
/** The longest a hold lasts, for a request that never answers. */
export const HOLD_MAX_MS = 10_000;

/**
 * A new page, or a page's other view, first shows a short "Loading…", so going from one tall page
 * to another dropped the scrollbar for the length of the load and brought it back. This holds the
 * column at the old height until the new content grows to it, or, for content that really is
 * shorter, until it has shown no loading UI for SETTLE_MS: the scrollbar then stays, or goes once,
 * but never flashes, however slow the load.
 * `column` goes on the padded column, `content` on the box holding the page inside it. Page
 * changes hold on their own; `holdNow` is for a page about to swap views in place.
 */
export function useSteadyHeight(pathname: string) {
  const column = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [steady] = useState(() => holder(column, content));

  useEffect(() => {
    const main = column.current;
    const page = content.current;
    if (!main || !page || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(steady.measured);
    observer.observe(main);
    observer.observe(page);
    return () => {
      observer.disconnect();
      steady.stop();
    };
  }, [steady]);

  const arrived = useRef(false);
  // Before paint, so no frame shows the collapsed column.
  useLayoutEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    steady.pageChanged();
  }, [pathname, steady]);

  return { column, content, holdNow: steady.holdNow };
}

/** The hold itself, outside React: one per workspace. */
function holder(column: RefObject<HTMLElement | null>, content: RefObject<HTMLDivElement | null>) {
  // The column's height when nothing is held, and the hold in force.
  let last = 0;
  let hold: { height: number; settling: number; stop: () => void } | null = null;

  const release = () => {
    if (!hold) return;
    hold.stop();
    hold = null;
    if (column.current) last = column.current.offsetHeight;
  };

  /** Lets go after SETTLE_MS unless loading UI shows up meanwhile. */
  const settleLater = (current: NonNullable<typeof hold>) => {
    if (current.settling) return;
    current.settling = window.setTimeout(() => {
      current.settling = 0;
      if (hold === current && !content.current?.querySelector(LOADING)) release();
    }, SETTLE_MS);
  };

  const check = () => {
    const main = column.current;
    const page = content.current;
    const current = hold;
    if (!current || !main || !page) return;
    const style = getComputedStyle(main);
    const natural = page.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (natural >= current.height) return release();
    if (page.querySelector(LOADING)) {
      window.clearTimeout(current.settling);
      current.settling = 0;
      return;
    }
    settleLater(current);
  };

  /** `now`: the new content is already in place. Otherwise (a view about to swap) the content is
   * still the old view, which would pass for "tall enough": wait for it to change. */
  const begin = (height: number, now: boolean) => {
    const main = column.current;
    const page = content.current;
    if (!main || !page || !height) return;
    hold?.stop();
    main.style.minHeight = `${height}px`;
    const cap = window.setTimeout(release, HOLD_MAX_MS);
    // Loading UI coming and going doesn't always resize anything.
    const changes = new MutationObserver(check);
    changes.observe(page, { childList: true, subtree: true });
    const current = {
      height,
      settling: 0,
      stop: () => {
        window.clearTimeout(cap);
        window.clearTimeout(current.settling);
        changes.disconnect();
        main.style.minHeight = "";
      },
    };
    hold = current;
    if (now) check();
    else settleLater(current);
  };

  return {
    /** From the ResizeObserver. */
    measured: () => {
      if (hold) check();
      else if (column.current) last = column.current.offsetHeight;
    },
    /** A page change while a hold is in force keeps that height: measuring now would measure
     * the next page's "Loading…". */
    pageChanged: () => begin(hold?.height ?? last, true),
    holdNow: () => {
      if (column.current) begin(Math.max(column.current.offsetHeight, hold?.height ?? 0), false);
    },
    stop: () => {
      hold?.stop();
      hold = null;
    },
  };
}

/** The workspace's `holdNow`; outside the workspace it does nothing. */
export const SteadyHeight = createContext<() => void>(() => {});

/** For a page about to swap one view for another in place: call it just before the swap. */
export const useHoldHeight = () => useContext(SteadyHeight);
