// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { prefetchRoute, useApi } from './useApi';
import { ApiError } from './api';
import { endPrefetchArrival, invalidateApiCache, noteRouteRead, prefetchFor, resetApiCache, routeReadsFor, scopeApiCache, storeResult } from './apiCache';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api, ApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }, errorMessage: (e: Error) => e.message }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
/** Visit `route` once so it remembers reading `path`, and end that arrival. */
async function visit(route: string, path: string, data: unknown) {
  window.history.replaceState(null, '', route);
  api.mockResolvedValueOnce(data);
  renderHook(() => useApi(path)).unmount();
  await settle();
  endPrefetchArrival();
}

test('a revisit without a prefetch reads for itself, as before (no copy from an earlier visit)', async () => {
  await visit('/admin/plans', '/admin/plans', { n: 1 });
  const next = deferred<{ n: number }>();
  api.mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => { next.resolve({ n: 2 }); });
  expect(result.current.data?.n).toBe(2);
  expect(api).toHaveBeenCalledTimes(2);
});

test('a finished arrival prefetch renders on the first frame, consistently for every hook on the page', async () => {
  await visit('/admin/plans', '/admin/plans', { n: 1 });
  api.mockResolvedValueOnce({ n: 2 });
  prefetchRoute('/admin/plans');
  await settle();
  const a = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  const b = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(a.result.current.data?.n).toBe(2);
  expect(b.result.current.data?.n).toBe(2);
  expect(a.result.current.loading).toBe(false);
  await settle();
  expect(api).toHaveBeenCalledTimes(2);
  // The arrival is over: anything mounted afterwards reads for itself.
  endPrefetchArrival();
  api.mockResolvedValueOnce({ n: 3 });
  const later = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(later.result.current.data).toBeNull();
  await settle();
  expect(later.result.current.data?.n).toBe(3);
});

test('an arrival waits for its pending prefetch instead of repeating it', async () => {
  await visit('/admin/studios', '/studios', { n: 1 });
  const pending = deferred<{ n: number }>();
  api.mockReturnValueOnce(pending.promise);
  prefetchRoute('/admin/studios');
  const { result } = renderHook(() => useApi<{ n: number }>('/studios'));
  expect(result.current.loading).toBe(true);
  await act(async () => { pending.resolve({ n: 2 }); });
  expect(api).toHaveBeenCalledTimes(2);
  expect(result.current.data?.n).toBe(2);
});

test('a failed, foreign, stale or rejected prefetch never stands in', async () => {
  // Failed: the arrival reads again and shows its own error.
  await visit('/admin/plans', '/admin/plans', { n: 1 });
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'down'));
  prefetchRoute('/admin/plans');
  await settle();
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'down'));
  const failed = renderHook(() => useApi('/admin/plans'));
  await settle();
  expect(failed.result.current.error).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(3);
  cleanup(); endPrefetchArrival(); api.mockReset();

  // Made for another page.
  await visit('/equipment', '/equipment/3/quote', { price: 10 });
  api.mockResolvedValueOnce({ price: 10 });
  prefetchRoute('/equipment');
  await settle();
  window.history.replaceState(null, '', '/admin/reservations');
  api.mockResolvedValueOnce({ price: 12 });
  const foreign = renderHook(() => useApi<{ price: number }>('/equipment/3/quote'));
  await settle();
  expect(foreign.result.current.data?.price).toBe(12);
  cleanup(); endPrefetchArrival();

  // Finished too long ago.
  window.history.replaceState(null, '', '/equipment');
  api.mockResolvedValueOnce({ price: 12 });
  prefetchRoute('/equipment');
  await settle();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
  api.mockResolvedValueOnce({ price: 14 });
  const stale = renderHook(() => useApi<{ price: number }>('/equipment/3/quote'));
  expect(stale.result.current.data).toBeNull();
  await settle();
  expect(stale.result.current.data?.price).toBe(14);
  cleanup(); endPrefetchArrival(); vi.restoreAllMocks();

  // Rejected by start time, including while still pending.
  const pending = deferred<{ price: number }>();
  api.mockReturnValueOnce(pending.promise);
  prefetchRoute('/equipment');
  api.mockResolvedValueOnce({ price: 16 });
  const rejected = renderHook(() => useApi<{ price: number }>('/equipment/3/quote', { acceptPrefetch: () => false }));
  await settle();
  expect(rejected.result.current.data?.price).toBe(16);
  await act(async () => { pending.resolve({ price: 15 }); });
  expect(rejected.result.current.data?.price).toBe(16);
});

test('reload() always starts its own read, superseding a pending one', async () => {
  const first = deferred<{ status: string }>();
  const second = deferred<{ status: string }>();
  api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = renderHook(() => useApi<{ status: string }>('/reservations', { retainOnReload: true }));
  await act(async () => {});
  act(() => result.current.reload());
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve({ status: 'cancelled' }); first.resolve({ status: 'confirmed' }); });
  expect(result.current.data?.status).toBe('cancelled');
});

test('an abandoned read is never picked up by a later visit', async () => {
  window.history.replaceState(null, '', '/membership');
  const slow = deferred<{ n: number }>();
  api.mockReturnValueOnce(slow.promise);
  renderHook(() => useApi('/me/memberships')).unmount();
  endPrefetchArrival();
  api.mockResolvedValueOnce({ n: 2 });
  const { result } = renderHook(() => useApi<{ n: number }>('/me/memberships'));
  await settle();
  slow.resolve({ n: 1 });
  await settle();
  expect(api).toHaveBeenCalledTimes(2);
  expect(result.current.data?.n).toBe(2);
});

test('a StrictMode replay of an arrival keeps the prefetched result instead of reloading', async () => {
  await visit('/admin/payments', '/admin/payments', { revision: 1 });
  api.mockResolvedValueOnce({ revision: 2 });
  prefetchRoute('/admin/payments');
  await settle();
  api.mockResolvedValue({ revision: 3 });
  const { result } = renderHook(() => useApi<{ revision: number }>('/admin/payments', { retainOnReload: true }), { wrapper: StrictMode });
  await settle();
  expect(result.current.data?.revision).toBe(2);
  expect(api).toHaveBeenCalledTimes(2);
});

test('writes, token renewal and sign-out cancel prefetches; sign-out also forgets route reads', async () => {
  for (const clear of [invalidateApiCache, resetApiCache]) {
    await visit('/admin/reservations', '/admin/reservations', { n: 1 });
    api.mockResolvedValueOnce({ n: 2 });
    prefetchRoute('/admin/reservations');
    await settle();
    clear();
    expect(prefetchFor('/admin/reservations')).toBeUndefined();
  }
  expect(routeReadsFor('/admin/reservations')).toHaveLength(0);
});

test('a different confirmed identity starts over', () => {
  scopeApiCache('staff-7');
  noteRouteRead('/', '/me/overview');
  scopeApiCache('staff-7');
  expect(routeReadsFor('/')).toHaveLength(1);
  scopeApiCache('staff-7 acting for member-12');
  expect(routeReadsFor('/')).toHaveLength(0);
});

test('requestKey and cache: false reads never use a prefetch', async () => {
  await visit('/admin/members', '/admin/users/14/access-readiness', { allowed: true });
  api.mockResolvedValueOnce({ allowed: true });
  prefetchRoute('/admin/members');
  await settle();
  api.mockResolvedValueOnce({ allowed: false }).mockResolvedValueOnce({ allowed: false });
  const privateRead = renderHook(() => useApi<{ allowed: boolean }>('/admin/users/14/access-readiness', { cache: false }));
  const keyed = renderHook(() => useApi<{ allowed: boolean }>('/admin/users/14/access-readiness', { requestKey: 1 }));
  expect(privateRead.result.current.data).toBeNull();
  await settle();
  expect(privateRead.result.current.data?.allowed).toBe(false);
  expect(keyed.result.current.data?.allowed).toBe(false);
  expect(api).toHaveBeenCalledTimes(4);
});

test('reuse: a stored setting renders at once and refreshes in the background', async () => {
  storeResult('/config', { timeZone: 'UTC' });
  const next = deferred<{ timeZone: string }>();
  api.mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useApi<{ timeZone: string }>('/config', { reuse: true }));
  expect(result.current.data?.timeZone).toBe('UTC');
  expect(result.current.loading).toBe(false);
  await act(async () => {});
  expect(result.current.refreshing).toBe(true);
  await act(async () => { next.resolve({ timeZone: 'America/New_York' }); });
  expect(result.current.data?.timeZone).toBe('America/New_York');
});

test('route memory and prefetches are bounded', () => {
  for (let i = 0; i < 130; i++) noteRouteRead(`/admin/members?page=${i}`, `/x/${i}`);
  expect(routeReadsFor('/admin/members?page=0')).toHaveLength(0);
  expect(routeReadsFor('/admin/members?page=129')).toHaveLength(1);
  api.mockReturnValue(new Promise(() => {}));
  for (let i = 30; i < 130; i++) prefetchRoute(`/admin/members?page=${i}`);
  for (let i = 0; i < 30; i++) { noteRouteRead(`/extra/${i}`, `/y/${i}`); prefetchRoute(`/extra/${i}`); }
  expect(prefetchFor('/x/30')).toBeUndefined();
  expect(prefetchFor('/y/29')).toBeDefined();
});
