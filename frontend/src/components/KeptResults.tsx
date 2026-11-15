// Lists read with useApi `retainOnChange`: the last results stay on screen while another page or
// filter loads, so the page keeps its height and the scrollbar doesn't flash.

import { useEffect, useRef, type ReactNode, type Ref } from "react";

/** What a list's read says about the results on screen. */
interface Read {
  data: unknown;
  /** The results answer an earlier page or filter; the new ones are on their way. */
  stale: boolean;
}

/**
 * A list's results. While they are stale they fade and can't be used, so nobody edits a row or
 * pages on from results that are about to change. Keep filters, search boxes and pagers outside:
 * whatever is inside loses focus while it waits.
 */
export function KeptResults({
  read,
  className,
  ref,
  children,
}: {
  read: Read;
  className?: string;
  /** From useResultsPaging, for the lists that page. */
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      className={className ? `kept-results ${className}` : "kept-results"}
      tabIndex={ref ? -1 : undefined}
      aria-busy={read.stale || undefined}
      inert={read.stale || undefined}
    >
      {children}
    </div>
  );
}

/**
 * Changing pages in a list read with `retainOnChange`. `turn` brings the top of the results into
 * view at once (the pager sits below them), and when the new page lands puts focus on them, so
 * keyboard and screen reader users carry on from the top of the new page. Focus moves only if it
 * is still on the control that turned the page, or was lost: anyone who has moved on keeps their
 * place. A page that fails to load moves nothing.
 */
export function useResultsPaging(read: Read) {
  const results = useRef<HTMLDivElement>(null);
  // The control that turned the page, until the new page settles.
  const turnedFrom = useRef<Element | null | undefined>(undefined);
  useEffect(() => {
    if (turnedFrom.current === undefined || read.stale) return;
    const from = turnedFrom.current;
    turnedFrom.current = undefined;
    if (read.data === null) return;
    const now = document.activeElement;
    if (now && now !== document.body && now !== from) return;
    results.current?.focus({ preventScroll: true });
  }, [read.stale, read.data]);
  const turn = (change: () => void) => {
    turnedFrom.current = document.activeElement;
    change();
    const box = results.current;
    if (box && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: "start", behavior: "instant" });
  };
  return { results, turn, busy: read.stale };
}
