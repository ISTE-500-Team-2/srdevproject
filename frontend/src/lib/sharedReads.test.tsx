// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { prefetchRoute, useApi } from './useApi';
import { ApiError } from './api';
import { invalidateApiCache, resetApiCache } from './apiCache';
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
