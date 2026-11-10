// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { api, setAccessToken, setCsrfToken } from './api';
import { addPrefetch, noteRouteRead, prefetchFor, readStored, routeReadsFor, storeResult } from './apiCache';

afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); });
const json = (data: unknown) => ({ status: 200, ok: true, json: async () => ({ data }) });
const pending = () => addPrefetch('/admin/plans', '/admin/plans', new Promise(() => {}));

test('every write cancels prefetches, both those started before it and during it', async () => {
  setAccessToken('token'); setCsrfToken('csrf');
  pending();
  let during: unknown = 'unset';
  vi.stubGlobal('fetch', vi.fn(async () => { during = prefetchFor('/admin/plans'); pending(); return json({ ok: true }); }));
  await api('/admin/plans', { method: 'POST', body: { name: 'x' } });
  expect(during).toBeUndefined();
  expect(prefetchFor('/admin/plans')).toBeUndefined();
});

test('a failed write still cancels prefetches (the server may have applied part of it)', async () => {
  setAccessToken('token'); setCsrfToken('csrf');
  pending();
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 409, ok: false, json: async () => ({ error: { code: 'CONFLICT', message: 'no' } }) })));
  await expect(api('/admin/plans', { method: 'POST' })).rejects.toThrow('no');
  expect(prefetchFor('/admin/plans')).toBeUndefined();
});

test('token renewal cancels prefetches; signing out also forgets route reads', async () => {
  // Another tab may have signed in as someone else; renewal installs that session
  // without a /auth/session check, so nothing started before it may stand in.
  setAccessToken('token'); setCsrfToken('csrf');
  pending();
  noteRouteRead('/admin/plans', '/admin/plans');
  vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken: 'next', csrfToken: 'csrf2' })));
  await api('/auth/refresh', { method: 'POST' });
  expect(prefetchFor('/admin/plans')).toBeUndefined();
  expect(routeReadsFor('/admin/plans')).toHaveLength(1);
  setAccessToken(null);
  expect(routeReadsFor('/admin/plans')).toHaveLength(0);
});

test('public server settings survive a change of account', () => {
  storeResult('/config', { timeZone: 'America/New_York' });
  setAccessToken(null);
  expect(readStored('/config')).toEqual({ data: { timeZone: 'America/New_York' } });
});
