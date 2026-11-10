// Starts downloading an area's code early (once per page load), so it is usually
// ready by the time its route renders: while someone is signing in, or alongside
// the session check when a page is opened directly.
/**
 * Starts `load` once and shares it; a failed download is forgotten, so the next
 * call retries. `loaded()` returns the module once it has arrived, so callers can
 * render it directly instead of suspending (React holds a suspended page back for
 * about 300 ms even when its code is already there).
 */
export function retryable<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  let value: T | undefined;
  const get = () => (pending ??= load().then(
    (module) => (value = module),
    (error) => { pending = undefined; throw error; },
  ));
  return Object.assign(get, { loaded: () => value });
}
export type AreaLoader<T> = ReturnType<typeof retryable<T>>;

export const loadMemberArea = retryable(() => import('./memberPages'));
export const loadStaffArea = retryable(() => import('./StaffArea'));

const quietly = (load: () => Promise<unknown>) => { void load().catch(() => {}); };
export const preloadMemberArea = () => quietly(loadMemberArea);
export const preloadStaffArea = () => quietly(loadStaffArea);

/** Preload what `pathname` will need; unknown or public paths preload nothing. */
export function preloadAreaFor(pathname: string) {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) preloadStaffArea();
  else if (/^\/(checkout-return|equipment|reservations|studios|certifications|classes|training|profile|membership)?\/?$/.test(pathname))
    preloadMemberArea();
}

/**
 * Someone is signing in: fetch both areas now (which one they need is known only
 * after sign-in), so landing afterwards doesn't wait for a download. Not deferred
 * to idle time: the login page animates, and password managers sign in fast.
 */
export function preloadSignedInAreas() {
  preloadMemberArea();
  preloadStaffArea();
}
