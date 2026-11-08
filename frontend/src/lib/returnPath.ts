import { matchPath } from 'react-router-dom';

type Place = { pathname: string; search: string; hash: string };

/**
 * Public pages are never a destination: they don't need a sign-in, and some act on
 * tokens or forward to their own ?next=, so a crafted link must not chain through them.
 */
const PUBLIC_PAGES = ['/login', '/loading', '/confirm-email', '/reset-password'];

/**
 * The page to open after signing in, from a `?next=` value. Only paths on this
 * site are accepted (so the parameter can't send anyone elsewhere), and never a
 * public page such as the login page itself.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  // Normalizing can turn /.//x into //x, which the router treats as another site.
  if (url.origin !== window.location.origin || url.pathname.startsWith('//')) return null;
  // Match the way the router will: decoded, any case, optional trailing slash.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (PUBLIC_PAGES.some((page) => matchPath(page, decoded))) return null;
  return url.pathname + url.search + url.hash;
}

/** The login URL that brings the user back to `place` once they sign in. */
export function loginPath(place: Place): string {
  const next = safeNext(place.pathname + place.search + place.hash);
  return next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
