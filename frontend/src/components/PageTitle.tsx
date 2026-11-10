import { useEffect, type ReactNode } from 'react';

export const SITE_TITLE = 'The Collaboratory';

/** Names the browser tab (and the page screen readers announce) after the current page. */
export function PageTitle({ title }: { title?: string }) {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
  }, [title]);
  return null;
}

/** Each page names its browser tab, e.g. "Membership · The Collaboratory". */
export const titled = (title: string, page: ReactNode) => <><PageTitle title={title} />{page}</>;
