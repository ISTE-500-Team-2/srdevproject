/**
 * Session-scoped store behind useApi's shared reads.
 *
 * Identical concurrent reads share one request (browsers serialize identical
 * in-flight GETs, costing a round trip each), and the route check can start a
 * page's reads early so they arrive with it. Pages never render a copy kept
 * from an earlier visit (only /config-like settings opt in to that); stored
 * results exist to hand a prefetch to the page it was made for. The store
 * never outlives the signed-in identity: any write or token renewal clears it
 * (see api.ts), a different confirmed identity clears it (scopeApiCache), and
 * signing out also forgets which reads each page makes.
 */
type Entry = { data: unknown; at: number };
type Inflight = { generation: number; promise: Promise<unknown> };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Inflight>();
const routeReads = new Map<string, string[]>();
/** Reads started early for an arriving page; a successful one lets one mount skip its own read. */
export type PrefetchMark = { route: string; startedAt: number; ok?: boolean; settledAt?: number };
const prefetched = new Map<string, PrefetchMark>();
let generation = 0;
/** Whose results the store holds: account, opened member account and roles (see AuthContext). */
let identity: string | null = null;

/** Server settings that are identical for every visitor survive identity changes. */
const SHARED_ACROSS_ACCOUNTS = new Set(['/config']);
/** Reads remembered per page; enough for the busiest page, bounded for search-driven pages. */
const MAX_READS_PER_ROUTE = 16;
/** Session-wide bounds; the least recently stored results and pages go first. */
const MAX_ENTRIES = 200;
const MAX_ROUTES = 100;
const MAX_PREFETCH_MARKS = 100;

export const cacheGeneration = () => generation;

export function readCache<T>(path: string): { data: T; at: number } | undefined {
  return entries.get(path) as { data: T; at: number } | undefined;
}

/** Stores a result only if no write or sign-out happened since the read started. */
export function writeCache(path: string, data: unknown, startedAt: number) {
  if (startedAt !== generation) return;
  entries.delete(path);
  entries.set(path, { data, at: Date.now() });
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    if (!SHARED_ACROSS_ACCOUNTS.has(key)) entries.delete(key);
  }
}

export function evictCache(path: string) {
  entries.delete(path);
}

export function joinInflight<T>(path: string): Promise<T> | undefined {
  const current = inflight.get(path);
  return current && current.generation === generation ? (current.promise as Promise<T>) : undefined;
}

export function trackInflight(path: string, promise: Promise<unknown>) {
  const entry = { generation, promise };
  inflight.set(path, entry);
  void promise.catch(() => {}).finally(() => {
    if (inflight.get(path) === entry) inflight.delete(path);
  });
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

export function markPrefetched(path: string, route: string): PrefetchMark {
  const mark: PrefetchMark = { route, startedAt: Date.now() };
  prefetched.delete(path);
  prefetched.set(path, mark);
  if (prefetched.size > MAX_PREFETCH_MARKS) prefetched.delete(prefetched.keys().next().value!);
  return mark;
}

export function peekPrefetched(path: string): PrefetchMark | undefined {
  return prefetched.get(path);
}

/** Once per prefetch: the arriving page learns whether that read succeeded and when. */
export function takePrefetched(path: string): PrefetchMark | undefined {
  const mark = prefetched.get(path);
  prefetched.delete(path);
  return mark;
}

/** After any write: drop cached results so no page shows pre-write data, and ignore older reads. */
export function invalidateApiCache() {
  generation++;
  inflight.clear();
  prefetched.clear();
  for (const key of entries.keys()) if (!SHARED_ACROSS_ACCOUNTS.has(key)) entries.delete(key);
}

/** On sign-out or expiry: also forget which reads pages make for this account. */
export function resetApiCache() {
  invalidateApiCache();
  routeReads.clear();
  identity = null;
}

/**
 * Called with each session the server confirms. A different identity (another
 * account signed in elsewhere, an opened member account, changed roles) must
 * never see the previous one's results, so the store starts over first.
 */
export function scopeApiCache(next: string) {
  if (identity !== null && identity !== next) resetApiCache();
  identity = next;
}

/** Tests only: start from an empty store. */
export function clearApiCacheForTests() {
  resetApiCache();
  entries.clear();
}
