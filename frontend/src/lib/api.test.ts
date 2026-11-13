// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { api, apiText, setAccessToken, setCsrfToken } from './api';

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

test('a signed-out visit stops at the CSRF lookup instead of calling refresh', async () => {
  const fetch = vi.fn(async (url: string) =>
    url === '/api/auth/csrf' ? Response.json({ data: { csrfToken: null } }) : Response.json({}, { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  const expired = vi.fn();
  window.addEventListener('session-expired', expired);
  await expect(api('/auth/session')).rejects.toMatchObject({ status: 401 });
  window.removeEventListener('session-expired', expired);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/csrf']);
  expect(expired).toHaveBeenCalledTimes(1);
});

const error = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const authorization = (call: unknown[]) => (call[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization;

test('a JSON error without a body keeps the generic failure', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })));
  await expect(api('/equipment')).rejects.toMatchObject({
    status: 502, code: 'REQUEST_FAILED', message: 'The request could not be completed.',
  });
});

test.each([
  ['JSON', (path: string) => api(path)],
  ['text', (path: string) => apiText(path)],
])('%s requests renew after a 401, retry once, then end the session', async (_kind, request) => {
  setAccessToken('stale');
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/auth/csrf') return Response.json({ data: { csrfToken: 'csrf' } });
    if (url === '/api/auth/refresh') return Response.json({ data: { accessToken: 'fresh', csrfToken: 'csrf2' } });
    return error(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  });
  vi.stubGlobal('fetch', fetch);
  const expired = vi.fn();
  window.addEventListener('session-expired', expired);
  await expect(request('/admin/compliance')).rejects.toMatchObject({ status: 401, message: 'Sign in to continue.' });
  window.removeEventListener('session-expired', expired);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/admin/compliance', '/api/auth/csrf', '/api/auth/refresh', '/api/admin/compliance',
  ]);
  expect(authorization(fetch.mock.calls[0]!)).toBe('Bearer stale');
  expect(authorization(fetch.mock.calls[3]!)).toBe('Bearer fresh');
  expect(expired).toHaveBeenCalledTimes(1);
});

test('a failed /auth/ request does not end the session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(error(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password.' } })));
  const expired = vi.fn();
  window.addEventListener('session-expired', expired);
  await expect(api('/auth/login', { method: 'POST' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  window.removeEventListener('session-expired', expired);
  expect(expired).not.toHaveBeenCalled();
});

test('text downloads send the bearer token and ask for CSV', async () => {
  setAccessToken('token');
  const fetch = vi.fn().mockResolvedValue(new Response('a,b\n1,2\n'));
  vi.stubGlobal('fetch', fetch);
  await expect(apiText('/admin/compliance?format=csv')).resolves.toBe('a,b\n1,2\n');
  expect(fetch).toHaveBeenCalledWith('/api/admin/compliance?format=csv', expect.objectContaining({
    credentials: 'include', headers: { Accept: 'text/csv', Authorization: 'Bearer token' },
  }));
});

test('a text download shows the server error message, not the raw JSON body', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(error(403, { error: { code: 'FORBIDDEN', message: 'Staff only.' } })));
  await expect(apiText('/admin/compliance?format=csv')).rejects.toMatchObject({
    status: 403, code: 'FORBIDDEN', message: 'Staff only.',
  });
});

test('a text download with a plain error body shows it as sent', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('Report unavailable', { status: 500 }))
    .mockResolvedValueOnce(new Response('', { status: 500 })));
  await expect(apiText('/admin/compliance?format=csv')).rejects.toMatchObject({
    status: 500, code: 'REQUEST_FAILED', message: 'Report unavailable',
  });
  await expect(apiText('/admin/compliance?format=csv')).rejects.toMatchObject({
    message: 'The request could not be completed.',
  });
});
