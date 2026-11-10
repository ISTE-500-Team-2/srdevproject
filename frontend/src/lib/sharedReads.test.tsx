// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { prefetchRoute, useApi } from './useApi';
import { ApiError } from './api';
import { cacheGeneration, invalidateApiCache, noteRouteRead, peekPrefetched, readCache, resetApiCache, routeReadsFor, scopeApiCache, writeCache } from './apiCache';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api, ApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }, errorMessage: (e: Error) => e.message }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

/** Let settled reads finish their bookkeeping (in-flight tracking clears a few ticks after the response). */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
/** Visit `route` once so it remembers reading `path`. */
async function visit(route: string, path: string, data: unknown) {
  window.history.replaceState(null, '', route);
  api.mockResolvedValueOnce(data);
  renderHook(() => useApi(path)).unmount();
  await settle();
}

test('a revisit never renders a copy from an earlier visit; it waits for a fresh read', async () => {
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

test('identical reads in flight at the same time share one request', async () => {
  const pending = deferred<{ n: number }>();
  api.mockReturnValue(pending.promise);
  const a = renderHook(() => useApi<{ n: number }>('/equipment'));
  const b = renderHook(() => useApi<{ n: number }>('/equipment'));
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ n: 7 }); });
  expect(a.result.current.data?.n).toBe(7);
  expect(b.result.current.data?.n).toBe(7);
});

test('a prefetch that succeeded for this arrival renders on the first frame without another read', async () => {
  await visit('/admin/plans', '/admin/plans', { n: 1 });
  api.mockResolvedValueOnce({ n: 2 });
  prefetchRoute('/admin/plans');
  await settle();
  const arrived = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(arrived.result.current.data?.n).toBe(2);
  expect(arrived.result.current.loading).toBe(false);
  await settle();
  expect(api).toHaveBeenCalledTimes(2);
  arrived.unmount();
  // The mark is spent: the next arrival reads for itself.
  api.mockResolvedValueOnce({ n: 3 });
  const again = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(again.result.current.data).toBeNull();
  await settle();
  expect(again.result.current.data?.n).toBe(3);
  expect(api).toHaveBeenCalledTimes(3);
});

test('an arrival joins a prefetch that is still in flight (loading until it lands)', async () => {
  await visit('/admin/studios', '/studios', { n: 1 });
  const pending = deferred<{ n: number }>();
  api.mockReturnValueOnce(pending.promise);
  prefetchRoute('/admin/studios');
  const { result } = renderHook(() => useApi<{ n: number }>('/studios'));
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => { pending.resolve({ n: 2 }); });
  expect(api).toHaveBeenCalledTimes(2);
  expect(result.current.data?.n).toBe(2);
});

test('a failed prefetch never stands in: the arrival reads again and shows its error', async () => {
  await visit('/admin/plans', '/admin/plans', { n: 1 });
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Server unavailable'));
  prefetchRoute('/admin/plans');
  await settle();
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Server unavailable'));
  const { result } = renderHook(() => useApi('/admin/plans'));
  await settle();
  expect(api).toHaveBeenCalledTimes(3);
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBeTruthy();
});

test('a prefetch made for another page, or too long ago, never stands in', async () => {
  await visit('/equipment', '/equipment/3/quote', { price: 10 });
  api.mockResolvedValueOnce({ price: 10 });
  prefetchRoute('/equipment');
  await settle();
  window.history.replaceState(null, '', '/admin/reservations');
  api.mockResolvedValueOnce({ price: 12 });
  const other = renderHook(() => useApi<{ price: number }>('/equipment/3/quote'));
  await settle();
  expect(other.result.current.data?.price).toBe(12);
  other.unmount();

  window.history.replaceState(null, '', '/equipment');
  api.mockResolvedValueOnce({ price: 12 });
  prefetchRoute('/equipment');
  await settle();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
  api.mockResolvedValueOnce({ price: 14 });
  const late = renderHook(() => useApi<{ price: number }>('/equipment/3/quote'));
  expect(late.result.current.data).toBeNull();
  await settle();
  expect(late.result.current.data?.price).toBe(14);
});

test('a write or sign-out cancels pending prefetches; a read overlapping a write is not stored', async () => {
  for (const clear of [invalidateApiCache, resetApiCache]) {
    await visit('/admin/reservations', '/admin/reservations', { n: 1 });
    api.mockResolvedValueOnce({ n: 2 });
    prefetchRoute('/admin/reservations');
    await settle();
    clear();
    api.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useApi('/admin/reservations'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    cleanup();
  }
  const stale = deferred<{ n: number }>();
  api.mockReturnValueOnce(stale.promise);
  renderHook(() => useApi('/admin/payments')).unmount();
  invalidateApiCache();
  await act(async () => { stale.resolve({ n: 1 }); });
  expect(readCache('/admin/payments')).toBeUndefined();
});

test('a resource the server refuses is evicted', async () => {
  await visit('/admin/members', '/admin/users/1', { secret: true });
  expect(readCache('/admin/users/1')).toBeDefined();
  api.mockRejectedValueOnce(new ApiError(403, 'PERMISSION_REQUIRED', 'Permission removed'));
  renderHook(() => useApi('/admin/users/1'));
  await settle();
  expect(readCache('/admin/users/1')).toBeUndefined();
});

test('changing requestKey starts its own read instead of joining the pending one', async () => {
  const first = deferred<{ user: number }>();
  const second = deferred<{ user: number }>();
  api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(({ key }) => useApi<{ user: number }>('/me/overview', { requestKey: key }), { initialProps: { key: 1 } });
  await act(async () => {});
  rerender({ key: 2 });
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => { first.resolve({ user: 1 }); second.resolve({ user: 2 }); });
  expect(result.current.data?.user).toBe(2);
  expect(readCache('/me/overview')).toBeUndefined();
});

test('cache: false reads are private: never served from, or stored in, the shared store', async () => {
  await visit('/admin/members', '/admin/users/14/access-readiness', { allowed: true });
  api.mockResolvedValueOnce({ allowed: true });
  prefetchRoute('/admin/members');
  await settle();
  const pending = deferred<{ allowed: boolean }>();
  api.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useApi<{ allowed: boolean }>('/admin/users/14/access-readiness', { cache: false }));
  expect(result.current.data).toBeNull();
  await act(async () => { pending.resolve({ allowed: false }); });
  expect(result.current.data?.allowed).toBe(false);
  expect(api).toHaveBeenCalledTimes(3);
});

test('reuse: a stored setting renders at once and refreshes in the background', async () => {
  writeCache('/config', { timeZone: 'UTC' }, cacheGeneration());
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

test('results are scoped to one identity, including an opened member account', () => {
  scopeApiCache('staff-7');
  writeCache('/me/overview', { name: 'Staff' }, cacheGeneration());
  noteRouteRead('/', '/me/overview');
  scopeApiCache('staff-7');
  expect(readCache('/me/overview')).toBeDefined();
  scopeApiCache('staff-7 acting for member-12');
  expect(readCache('/me/overview')).toBeUndefined();
  expect(routeReadsFor('/')).toHaveLength(0);
});

test('the store is bounded: oldest results, pages and prefetch marks go first', () => {
  writeCache('/config', { timeZone: 'UTC' }, cacheGeneration());
  for (let i = 0; i < 260; i++) writeCache(`/admin/users?offset=${i}`, i, cacheGeneration());
  expect(readCache('/admin/users?offset=0')).toBeUndefined();
  expect(readCache('/admin/users?offset=259')).toBeDefined();
  expect(readCache('/config')).toBeDefined();
  for (let i = 0; i < 130; i++) noteRouteRead(`/admin/members?page=${i}`, `/x/${i}`);
  expect(routeReadsFor('/admin/members?page=0')).toHaveLength(0);
  expect(routeReadsFor('/admin/members?page=129')).toHaveLength(1);
  api.mockReturnValue(new Promise(() => {}));
  for (let i = 30; i < 130; i++) prefetchRoute(`/admin/members?page=${i}`);
  for (let i = 0; i < 30; i++) noteRouteRead(`/extra/${i}`, `/y/${i}`);
  for (let i = 0; i < 30; i++) prefetchRoute(`/extra/${i}`);
  expect(peekPrefetched('/x/30')).toBeUndefined();
  expect(peekPrefetched('/y/29')).toBeDefined();
});

test('signing out forgets which reads each page makes', async () => {
  await visit('/admin/members', '/admin/users?search=', {});
  resetApiCache();
  api.mockClear();
  prefetchRoute('/admin/members');
  expect(api).not.toHaveBeenCalled();
});
