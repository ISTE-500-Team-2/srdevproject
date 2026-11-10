// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { api, setAccessToken, setCsrfToken } from './api';
import { cacheGeneration, readCache, writeCache } from './apiCache';

afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); });
const json = (data: unknown) => ({ status: 200, ok: true, json: async () => ({ data }) });

test('every write clears cached reads, before it starts and after it finishes', async () => {
  setAccessToken('token'); setCsrfToken('csrf');
  writeCache('/admin/plans', { n: 1 }, cacheGeneration());
  let during = -1;
  vi.stubGlobal('fetch', vi.fn(async () => { during = cacheGeneration(); return json({ ok: true }); }));
  const before = cacheGeneration();
  await api('/admin/plans', { method: 'POST', body: { name: 'x' } });
  expect(readCache('/admin/plans')).toBeUndefined();
  // A read started while the write was in flight belongs to an older generation and is dropped.
  expect(during).toBeGreaterThan(before);
  expect(cacheGeneration()).toBeGreaterThan(during);
});

test('a failed write still invalidates (the server may have applied part of it)', async () => {
  setAccessToken('token'); setCsrfToken('csrf');
  writeCache('/admin/plans', { n: 1 }, cacheGeneration());
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 409, ok: false, json: async () => ({ error: { code: 'CONFLICT', message: 'no' } }) })));
  await expect(api('/admin/plans', { method: 'POST' })).rejects.toThrow('no');
  expect(readCache('/admin/plans')).toBeUndefined();
});

test('token rotation keeps cached reads; signing out drops them', async () => {
  setAccessToken('token'); setCsrfToken('csrf');
  writeCache('/me/overview', { n: 1 }, cacheGeneration());
  vi.stubGlobal('fetch', vi.fn(async () => json({ accessToken: 'next', csrfToken: 'csrf2' })));
  await api('/auth/refresh', { method: 'POST' });
  expect(readCache('/me/overview')).toEqual(expect.objectContaining({ data: { n: 1 } }));
  setAccessToken(null);
  expect(readCache('/me/overview')).toBeUndefined();
});

test('public server settings survive a change of account', () => {
  writeCache('/config', { timeZone: 'America/New_York' }, cacheGeneration());
  setAccessToken(null);
  expect(readCache('/config')).toEqual(expect.objectContaining({ data: { timeZone: 'America/New_York' } }));
});
