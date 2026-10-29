// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { api, setAccessToken, setCsrfToken } from './api';

afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); });
test.each(['/auth/password-reset', '/auth/password-reset/check', '/auth/password-reset/confirm'])(
  '%s is callable by a signed-out visitor without attempting session refresh', async path => {
    const fetch = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetch);
    await api(path, { method: 'POST', body: { token: 'test' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api${path}`, expect.objectContaining({ method: 'POST' }));
  },
);
