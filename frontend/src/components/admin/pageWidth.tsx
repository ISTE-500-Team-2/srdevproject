import { createContext, useContext, useLayoutEffect } from "react";

/**
 * How wide a staff page may grow. The shell centres the page and caps it:
 * narrow for forms and settings, standard for lists, wide (no cap) for
 * schedules, dashboards and wide tables.
 */
export type PageWidth = "narrow" | "standard" | "wide";

export const PageWidthContext = createContext<(width: PageWidth) => void>(() => {});

/**
 * Declares this page's width while it is mounted; the shell falls back to standard.
 * Undefined declares nothing, leaving the choice to a page further down.
 */
export function usePageWidth(width: PageWidth | undefined) {
  const setWidth = useContext(PageWidthContext);
  // Before paint, so the page never flashes at the wrong width.
  useLayoutEffect(() => {
    if (!width) return;
    setWidth(width);
    return () => setWidth("standard");
  }, [setWidth, width]);
}
