// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { api, apiText, setAccessToken, setAccountSubject, setCsrfToken } from './api';

afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); setAccountSubject(null); });
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

test('a JSON error body names the invalid field when the server sends one', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(error(400, { error: { code: 'VALIDATION_ERROR', message: 'Enter an email.', field: 'email' } }))
    .mockResolvedValueOnce(error(400, { error: { code: 'VALIDATION_ERROR', message: 'Enter an email.' } }))
    .mockResolvedValueOnce(error(400, { error: { code: 'VALIDATION_ERROR', message: 'Enter an email.', field: 7 } })));
  await expect(api('/auth/register', { method: 'POST' })).rejects.toMatchObject({
    status: 400, code: 'VALIDATION_ERROR', message: 'Enter an email.', field: 'email',
  });
  await expect(api('/auth/register', { method: 'POST' })).rejects.toMatchObject({ field: undefined });
  await expect(api('/auth/register', { method: 'POST' })).rejects.toMatchObject({ field: undefined });
});

test('a JSON error without a body keeps the generic failure', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 500 })));
  await expect(api('/equipment')).rejects.toMatchObject({
    status: 500, code: 'REQUEST_FAILED', message: 'The request could not be completed.',
  });
});

test.each([502, 503, 504])('a gateway %i with no app error reads as the server being unreachable', async (status) => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status })));
  await expect(api('/equipment')).rejects.toMatchObject({
    status, code: 'SERVER_UNREACHABLE', message: 'Cannot reach the server. Please try again.',
  });
});

test('a gateway error that carries an app error keeps it', async () => {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'MAINTENANCE', message: 'Back at noon.' } }, { status: 503 })));
  await expect(api('/equipment')).rejects.toMatchObject({ status: 503, code: 'MAINTENANCE', message: 'Back at noon.' });
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

// A tab signed in as person 1; the browser's refresh cookie now renews as `renewedAs`.
function signedInTab(renewedAs: number) {
  let saves = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/auth/login') return Response.json({ data: { accessToken: 'mine', csrfToken: 'csrf', user: { id: 1 } } });
    if (url === '/api/auth/csrf') return Response.json({ data: { csrfToken: 'csrf' } });
    if (url === '/api/auth/refresh') return Response.json({ data: { accessToken: `renewed-${renewedAs}`, csrfToken: 'csrf2', user: { id: renewedAs } } });
    // The first save finds this tab's sign-in ended.
    if (url === '/api/me/profile') return ++saves > 1 ? Response.json({ data: { saved: true } }) : error(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    return error(404, {});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('a renewal that comes back as someone else does not send the request as them', async () => {
  const fetch = signedInTab(2);
  await api('/auth/login', { method: 'POST' });
  const expired = vi.fn();
  window.addEventListener('session-expired', expired);
  await expect(api('/me/profile', { method: 'PATCH', body: { firstName: 'A' } })).rejects.toMatchObject({ status: 401, code: 'SIGNED_IN_ELSEWHERE' });
  window.removeEventListener('session-expired', expired);
  // The save is not retried under the other person's token.
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/login', '/api/me/profile', '/api/auth/csrf', '/api/auth/refresh']);
  expect(expired).toHaveBeenCalledTimes(1);
});

test('a renewal for the same person retries the request as before', async () => {
  const fetch = signedInTab(1);
  await api('/auth/login', { method: 'POST' });
  await expect(api('/me/profile', { method: 'PATCH', body: { firstName: 'A' } })).resolves.toEqual({ saved: true });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/login', '/api/me/profile', '/api/auth/csrf', '/api/auth/refresh', '/api/me/profile']);
  expect(authorization(fetch.mock.calls[4]!)).toBe('Bearer renewed-1');
});

test.each([true, false])('a booking keeps its original account through renewal (had access token: %s)', async hadToken => {
  const bookings: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/auth/login') return Response.json({ data: { accessToken: 'old', csrfToken: 'csrf', user: { id: 1 } } });
    if (url === '/api/auth/csrf') return Response.json({ data: { csrfToken: 'csrf' } });
    if (url === '/api/auth/refresh') return Response.json({ data: { accessToken: 'fresh', csrfToken: 'csrf2', user: { id: 1 } } });
    expect(url).toBe('/api/reservations');
    bookings.push(init);
    return hadToken && bookings.length === 1 ? error(401, {}) : Response.json({ data: { id: 123 } });
  }));
  if (hadToken) await api('/auth/login', { method: 'POST' });
  setAccountSubject(42);
  const booking = api('/reservations', { method: 'POST', body: { roomId: 5 } });
  setAccountSubject(43);
  await expect(booking).resolves.toEqual({ id: 123 });

  const headers = bookings.map(({ headers }) => new Headers(headers));
  expect(headers.map(header => header.get('X-Account-Subject'))).toEqual(hadToken ? ['42', '42'] : ['42']);
  expect(headers.at(-1)?.get('Authorization')).toBe('Bearer fresh');
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

test('changes name the account the tab is showing, and a changed account asks for the open one', async () => {
  setAccessToken('token'); setCsrfToken('csrf'); setAccountSubject(42);
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(Response.json({ data: { id: 1 } }))
    .mockResolvedValueOnce(error(409, { error: { code: 'ACCOUNT_CHANGED', message: 'A different account is open now.' } }));
  vi.stubGlobal('fetch', fetch);
  const changed = vi.fn();
  window.addEventListener('account-changed', changed);
  try {
    await api('/reservations');
    await api('/reservations', { method: 'POST', body: {} });
    const headers = (call: unknown[]) => (call[1] as RequestInit & { headers: Record<string, string> }).headers;
    // Reads never carry it; they follow whatever account is open.
    expect(headers(fetch.mock.calls[0]!)['X-Account-Subject']).toBeUndefined();
    expect(headers(fetch.mock.calls[1]!)['X-Account-Subject']).toBe('42');
    expect(changed).not.toHaveBeenCalled();
    await expect(api('/reservations', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_CHANGED' });
    expect(changed).toHaveBeenCalledTimes(1);
    setAccountSubject(null);
    fetch.mockResolvedValueOnce(Response.json({ data: { id: 2 } }));
    await api('/reservations', { method: 'POST', body: {} });
    expect(headers(fetch.mock.calls[3]!)['X-Account-Subject']).toBeUndefined();
  } finally { window.removeEventListener('account-changed', changed); setAccountSubject(null); }
});

test('two tabs renew one after the other, each sending the cookie the last renewal set', async () => {
  // A stand-in for the browser: one shared refresh cookie, read when a request is sent and
  // replaced when a refresh answers, and Web Locks that queue requests for the same name.
  let cookie = 0;
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
    const turn = queue.then(callback);
    queue = turn.catch(() => undefined);
    return turn;
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const sent = cookie;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (url === '/api/auth/csrf') { log.push(`csrf r${sent}`); return Response.json({ data: { csrfToken: 'csrf' } }); }
    if (url === '/api/auth/refresh') {
      log.push(`refresh r${sent}`);
      cookie = sent + 1;
      return Response.json({ data: { accessToken: `access${cookie}`, csrfToken: 'csrf' } });
    }
    return Response.json({ data: init.headers.Authorization });
  }));
  try {
    vi.resetModules();
    const tabA = await import('./api');
    vi.resetModules();
    const tabB = await import('./api');
    const tokens = await Promise.all([tabA.api('/me/overview'), tabB.api('/me/overview')]);
    expect(request).toHaveBeenCalledWith('arbor-session-renewal', expect.any(Function));
    expect(log).toEqual(['csrf r0', 'refresh r0', 'csrf r1', 'refresh r1']);
    expect(tokens).toEqual(['Bearer access1', 'Bearer access2']);
  } finally {
    delete (navigator as { locks?: unknown }).locks;
  }
});
