// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { loadShared, useApi } from './useApi';
import { readStored, storeResult } from './apiCache';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

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
  expect(readStored('/config')).toEqual({ data: { timeZone: 'America/New_York' } });
});

test('reuse: with nothing stored yet it loads like any read, and stores the result', async () => {
  api.mockResolvedValueOnce({ timeZone: 'UTC' });
  const { result } = renderHook(() => useApi<{ timeZone: string }>('/config', { reuse: true }));
  expect(result.current.loading).toBe(true);
  await act(async () => {});
  expect(result.current.data?.timeZone).toBe('UTC');
  expect(readStored('/config')).toEqual({ data: { timeZone: 'UTC' } });
});

test('loadShared stores what it reads for later reuse readers', async () => {
  api.mockResolvedValueOnce({ demoLogin: false, timeZone: 'UTC' });
  await loadShared('/config');
  expect(readStored('/config')).toEqual({ data: { demoLogin: false, timeZone: 'UTC' } });
});

test('reads without reuse never render a stored copy', async () => {
  storeResult('/config', { timeZone: 'UTC' });
  api.mockReturnValueOnce(new Promise(() => {}));
  const { result } = renderHook(() => useApi('/config'));
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
});
