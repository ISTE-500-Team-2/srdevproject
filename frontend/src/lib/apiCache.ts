/**
 * Session-scoped state behind useApi's arrival prefetch.
 *
 * Each page remembers which reads it made (per route). When the route check
 * revalidates the session for a later visit, it starts those reads at the same
 * time, so the page's data arrives with the check instead of one round trip
 * after it. A prefetch only serves the page arriving with that check: marks are
 * dropped right after the page's first commit (endPrefetchArrival), by any write
 * or token renewal (api.ts), and when the confirmed identity changes
 * (scopeApiCache). Pages never render data kept from an earlier visit; the only
 * stored results are settings that are the same for everyone (/config).
 */

/** A read started for an arriving page while its session check runs. */
export type PrefetchMark = { route: string; startedAt: number; promise: Promise<unknown>; ok?: boolean; data?: unknown; settledAt?: number };

/** Settings that are the same for every visitor and account (see useApi `reuse`). */
const stored = new Map<string, unknown>();
const routeReads = new Map<string, string[]>();
const prefetched = new Map<string, PrefetchMark>();
/** Whose reads the route memory holds: account, opened member account and roles (see AuthContext). */
let identity: string | null = null;

/** Reads remembered per page; enough for the busiest page, bounded for search-driven pages. */
const MAX_READS_PER_ROUTE = 16;
const MAX_ROUTES = 100;
const MAX_PREFETCHES = 100;

export function readStored<T>(path: string): { data: T } | undefined {
  return stored.has(path) ? { data: stored.get(path) as T } : undefined;
}

export function storeResult(path: string, data: unknown) {
  stored.set(path, data);
}

/** Remember that `route` (pathname + search) loads `path`, so a later visit can start it early. */
export function noteRouteRead(route: string, path: string) {
  const reads = routeReads.get(route) ?? [];
  if (reads.includes(path)) return;
  reads.push(path);
  if (reads.length > MAX_READS_PER_ROUTE) reads.shift();
  routeReads.delete(route);
  routeReads.set(route, reads);
  if (routeReads.size > MAX_ROUTES) routeReads.delete(routeReads.keys().next().value!);
}

export function routeReadsFor(route: string): readonly string[] {
  return routeReads.get(route) ?? [];
}

export function addPrefetch(path: string, route: string, promise: Promise<unknown>): PrefetchMark {
  const mark: PrefetchMark = { route, startedAt: Date.now(), promise };
  prefetched.delete(path);
  prefetched.set(path, mark);
  if (prefetched.size > MAX_PREFETCHES) prefetched.delete(prefetched.keys().next().value!);
  return mark;
}

export function prefetchFor(path: string): PrefetchMark | undefined {
  return prefetched.get(path);
}

/**
 * The arriving page has mounted (its hooks' effects ran before this). Whatever
 * was prefetched for that arrival must not serve later mounts, such as a panel
 * opened afterwards, which read for themselves (the identity may have changed).
 */
export function endPrefetchArrival() {
  prefetched.clear();
}

/** After any write or token renewal: no prefetch started before it may stand in for a read. */
export function invalidateApiCache() {
  prefetched.clear();
}

/** On sign-out or expiry: also forget which reads pages make for this account. */
export function resetApiCache() {
  prefetched.clear();
  routeReads.clear();
  identity = null;
}

/**
 * Called with each session the server confirms. A different identity (another
 * account signed in elsewhere, an opened member account, changed roles) starts
 * over, so nothing started for the previous one serves the new one.
 */
export function scopeApiCache(next: string) {
  if (identity !== null && identity !== next) resetApiCache();
  identity = next;
}

/** Tests only: start from an empty store. */
export function clearApiCacheForTests() {
  resetApiCache();
  stored.clear();
}
