// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { prefetchRoute, useApi } from './useApi';
import { ApiError } from './api';
import { invalidateApiCache, readCache, resetApiCache, routeReadsFor, scopeApiCache, writeCache, cacheGeneration, noteRouteRead } from './apiCache';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));
afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState(null, '', '/'); });

/** Let settled reads finish their bookkeeping (in-flight tracking clears a few ticks after the response). */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

test('a revisited resource renders cached data on the first frame, then revalidates in the background', async () => {
  api.mockResolvedValueOnce({ n: 1 });
  const first = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  await act(async () => {});
  first.unmount();
  const next = deferred<{ n: number }>();
  api.mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(result.current.data?.n).toBe(1);
  expect(result.current.loading).toBe(false);
  await act(async () => {});
  expect(result.current.refreshing).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => { next.resolve({ n: 2 }); });
  expect(result.current.data?.n).toBe(2);
  expect(result.current.refreshing).toBe(false);
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

test('a revoked resource is not shown from cache once the server refuses it', async () => {
  api.mockResolvedValueOnce({ secret: true });
  renderHook(() => useApi('/admin/users/1')).unmount();
  await settle();
  api.mockRejectedValueOnce(Object.assign(new ApiError(403, 'PERMISSION_REQUIRED', 'Permission removed'), { status: 403 }));
  const { result } = renderHook(() => useApi('/admin/users/1'));
  await act(async () => {});
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBeTruthy();
  // Evicted: a later visit starts from a real loading state, not the refused data.
  api.mockReturnValueOnce(new Promise(() => {}));
  const later = renderHook(() => useApi('/admin/users/1'));
  expect(later.result.current.data).toBeNull();
  expect(later.result.current.loading).toBe(true);
});

test('after a write or sign-out, earlier results are never shown again', async () => {
  for (const clear of [invalidateApiCache, resetApiCache]) {
    api.mockResolvedValueOnce({ n: 1 });
    renderHook(() => useApi('/admin/reservations')).unmount();
    await settle();
    clear();
    api.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useApi('/admin/reservations'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    cleanup();
  }
});

test('a read that started before a write is not stored as current', async () => {
  const stale = deferred<{ n: number }>();
  api.mockReturnValueOnce(stale.promise);
  const view = renderHook(() => useApi<{ n: number }>('/admin/payments'));
  await act(async () => {});
  invalidateApiCache();
  await act(async () => { stale.resolve({ n: 1 }); });
  view.unmount();
  api.mockReturnValueOnce(new Promise(() => {}));
  const { result } = renderHook(() => useApi('/admin/payments'));
  expect(result.current.data).toBeNull();
});

test('prefetching a known page lets its next arrival skip the duplicate read, once', async () => {
  window.history.replaceState(null, '', '/admin/plans');
  api.mockResolvedValueOnce({ n: 1 });
  renderHook(() => useApi('/admin/plans')).unmount();
  await settle();
  expect(api).toHaveBeenCalledTimes(1);

  // The route check starts the page's known reads; the page mounts after they return.
  api.mockResolvedValueOnce({ n: 2 });
  prefetchRoute('/admin/plans');
  await settle();
  expect(api).toHaveBeenCalledTimes(2);
  const arrived = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  expect(arrived.result.current.data?.n).toBe(2);
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(2);
  arrived.unmount();

  // Without a fresh prefetch the next arrival revalidates as usual.
  api.mockResolvedValueOnce({ n: 3 });
  const again = renderHook(() => useApi<{ n: number }>('/admin/plans'));
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(3);
  expect(again.result.current.data?.n).toBe(3);
});

test('an arrival joins a prefetch that is still in flight instead of repeating it', async () => {
  window.history.replaceState(null, '', '/admin/studios');
  api.mockResolvedValueOnce({ n: 1 });
  renderHook(() => useApi('/studios')).unmount();
  await settle();
  const pending = deferred<{ n: number }>();
  api.mockReturnValueOnce(pending.promise);
  prefetchRoute('/admin/studios');
  const { result } = renderHook(() => useApi<{ n: number }>('/studios'));
  expect(result.current.data?.n).toBe(1);
  await act(async () => { pending.resolve({ n: 2 }); });
  expect(api).toHaveBeenCalledTimes(2);
  expect(result.current.data?.n).toBe(2);
});

test('signing out forgets which reads each page makes', async () => {
  window.history.replaceState(null, '', '/admin/members');
  api.mockResolvedValue({});
  renderHook(() => useApi('/admin/users?search=')).unmount();
  await settle();
  resetApiCache();
  api.mockClear();
  prefetchRoute('/admin/members');
  expect(api).not.toHaveBeenCalled();
});

test('a failed prefetch never stands in for the arriving page\'s own read', async () => {
  window.history.replaceState(null, '', '/admin/plans');
  api.mockResolvedValueOnce({ n: 1 });
  renderHook(() => useApi('/admin/plans')).unmount();
  await settle();
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Server unavailable'));
  prefetchRoute('/admin/plans');
  await settle();
  // The arrival reads again (and would show its error) instead of presenting old data as current.
  api.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Server unavailable'));
  const { result } = renderHook(() => useApi('/admin/plans'));
  await settle();
  expect(api).toHaveBeenCalledTimes(3);
  expect(result.current.error).toBeTruthy();
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
  // Keyed reads are private: nothing was stored for other callers.
  expect(readCache('/me/overview')).toBeUndefined();
});

test('cache: false never renders a stored result and waits for a fresh read', async () => {
  writeCache('/admin/users/14', { revision: 1 }, cacheGeneration());
  const pending = deferred<{ revision: number }>();
  api.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useApi<{ revision: number }>('/admin/users/14', { retainOnReload: true, cache: false }));
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => { pending.resolve({ revision: 2 }); });
  expect(result.current.data?.revision).toBe(2);
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

test('the store is bounded: oldest results and pages are dropped first', () => {
  writeCache('/config', { timeZone: 'UTC' }, cacheGeneration());
  for (let i = 0; i < 260; i++) writeCache(`/admin/users?offset=${i}`, i, cacheGeneration());
  expect(readCache('/admin/users?offset=0')).toBeUndefined();
  expect(readCache('/admin/users?offset=259')).toBeDefined();
  expect(readCache('/config')).toBeDefined();
  for (let i = 0; i < 130; i++) noteRouteRead(`/admin/members?page=${i}`, '/x');
  expect(routeReadsFor('/admin/members?page=0')).toHaveLength(0);
  expect(routeReadsFor('/admin/members?page=129')).toHaveLength(1);
});

test('if revalidating cached data fails, the failure shows as it would on a first load', async () => {
  api.mockResolvedValueOnce({ allClear: true });
  renderHook(() => useApi('/admin/compliance')).unmount();
  await settle();
  api.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Server unavailable'));
  const { result } = renderHook(() => useApi('/admin/compliance'));
  expect(result.current.data).toEqual({ allClear: true });
  await settle();
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBeTruthy();
  expect(result.current.loading).toBe(false);
});

test('a form opened on cached data keeps its draft when the revalidated record arrives', async () => {
  api.mockResolvedValueOnce({ revision: 1 });
  renderHook(() => useApi<{ revision: number }>('/admin/payments')).unmount();
  await settle();
  const pending = deferred<{ revision: number }>();
  api.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useApi<{ revision: number }>('/admin/payments'));
  expect(result.current.data?.revision).toBe(1);
  // Staff start typing into the form rendered from the cached revision.
  const form = document.createElement('form'); form.className = 'management-form';
  const input = document.createElement('input'); input.defaultValue = ''; form.append(input); document.body.append(form);
  input.focus(); input.value = 'Receipt 4411';
  await act(async () => { pending.resolve({ revision: 2 }); });
  expect(result.current.data?.revision).toBe(1);
  expect(result.current.refreshing).toBe(false);
  form.remove();
});

test('a prefetch made for another page never lets this page skip its read', async () => {
  window.history.replaceState(null, '', '/equipment');
  api.mockResolvedValueOnce({ price: 10 });
  renderHook(() => useApi('/equipment/3/quote')).unmount();
  await settle();
  api.mockResolvedValueOnce({ price: 10 });
  prefetchRoute('/equipment');
  await settle();
  // The quote is opened later from a different page; it must read the current price.
  window.history.replaceState(null, '', '/admin/reservations');
  api.mockResolvedValueOnce({ price: 12 });
  const { result } = renderHook(() => useApi<{ price: number }>('/equipment/3/quote'));
  await settle();
  expect(api).toHaveBeenCalledTimes(3);
  expect(result.current.data?.price).toBe(12);
});
