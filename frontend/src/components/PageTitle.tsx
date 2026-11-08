import { useEffect } from 'react';

export const SITE_TITLE = 'The Collaboratory';

/** Names the browser tab (and the page screen readers announce) after the current page. */
export function PageTitle({ title }: { title?: string }) {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
  }, [title]);
  return null;
}
