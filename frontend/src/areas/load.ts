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
 * Someone is starting to sign in: fetch the member site now (most people signing
 * in are members). The staff workspace is fetched only once sign-in confirms a
 * staff role (prepareArrival), so members and visitors never download it here.
 */
export function preloadForSignIn() {
  preloadMemberArea();
}

/**
 * Signed in: finish loading the area the next page needs before going there, so it
 * renders at once (a page that suspends is held back ~300 ms even after its code
 * arrives). A failed download doesn't block: the page shows its reload screen.
 */
export async function prepareArrival(role: string, destination: string) {
  await (arrivalArea(role, destination) === 'staff' ? loadStaffArea() : loadMemberArea()).catch(() => {});
}

/** Which area a person with `role` lands in at `destination`: only staff reach the workspace. */
export function arrivalArea(role: string, destination: string): 'staff' | 'member' {
  const path = destination.split(/[?#]/)[0];
  const staff = role === 'staff' || role === 'admin';
  return staff && (path === '/' || path === '/admin' || path.startsWith('/admin/')) ? 'staff' : 'member';
}
