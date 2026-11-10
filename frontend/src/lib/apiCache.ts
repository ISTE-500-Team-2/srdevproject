/**
 * Session-scoped store for GET results shared by every useApi caller.
 *
 * A page the user has already opened renders its last data at once and
 * revalidates in the background, and identical concurrent reads share one
 * request (browsers serialize identical in-flight GETs, costing a round trip
 * each). The store never outlives the signed-in identity: any write clears it
 * (see api.ts), and signing out also forgets which reads each page makes.
 */
type Entry = { data: unknown; at: number };
type Inflight = { generation: number; promise: Promise<unknown> };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Inflight>();
const routeReads = new Map<string, string[]>();
/** Reads started early for an arriving page; each lets one mount skip its own identical read. */
const prefetched = new Set<string>();
let generation = 0;

/** Server settings that are identical for every visitor survive identity changes. */
const SHARED_ACROSS_ACCOUNTS = new Set(['/config']);
/** Reads remembered per page; enough for the busiest page, bounded for search-driven pages. */
const MAX_READS_PER_ROUTE = 16;

export const cacheGeneration = () => generation;

export function readCache<T>(path: string): { data: T; at: number } | undefined {
  return entries.get(path) as { data: T; at: number } | undefined;
}

/** Stores a result only if no write or sign-out happened since the read started. */
export function writeCache(path: string, data: unknown, startedAt: number) {
  if (startedAt === generation) entries.set(path, { data, at: Date.now() });
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
  routeReads.set(route, reads);
}

export function routeReadsFor(route: string): readonly string[] {
  return routeReads.get(route) ?? [];
}

export function markPrefetched(path: string) {
  prefetched.add(path);
}

/** True once per prefetch: the arriving page may use that result instead of reading again. */
export function takePrefetched(path: string) {
  return prefetched.delete(path);
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
}

/** Tests only: start from an empty store. */
export function clearApiCacheForTests() {
  resetApiCache();
  entries.clear();
}
