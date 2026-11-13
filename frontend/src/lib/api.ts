export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The invalid request-body property, when the server names one. */
    public field?: string,
  ) {
    super(message);
  }
}
let accessToken: string | null = null;
export function setAccessToken(value: string | null) { accessToken = value; }
let refreshing: Promise<void> | null = null;
let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}
// Sign-in, recovery and public config requests work without a session: they
// never renew it first or retry after a 401.
const SESSIONLESS = new Set(['/auth/login','/auth/register','/auth/confirm','/auth/confirmation','/auth/password-reset','/auth/password-reset/check','/auth/password-reset/confirm','/auth/demo','/auth/csrf','/auth/refresh','/config']);
const FAILED = 'The request could not be completed.';

/**
 * The one authenticated transport behind api() and apiText(): renews a missing
 * access token first, sends the bearer token, cookies and, for mutations, the
 * JSON body and CSRF token, and after a 401 renews once and retries. The caller
 * decodes the response.
 */
async function send(
  path: string,
  { method = 'GET', body, signal, accept }: { method?: string; body?: unknown; signal?: AbortSignal; accept: string },
): Promise<Response> {
  const sessionless = SESSIONLESS.has(path);
  if (!accessToken && !sessionless) await renew();
  const mutation = !['GET', 'HEAD'].includes(method);
  const perform = () => fetch('/api' + path, {
    method,
    credentials: 'include',
    signal,
    headers: {
      Accept: accept,
      ...(accessToken ? {Authorization: `Bearer ${accessToken}`} : {}),
      ...(mutation ? { 'Content-Type': 'application/json' } : {}),
      ...(mutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  let response = await perform();
  if (response.status === 401 && !sessionless) {
    await renew();
    response = await perform();
  }
  return response;
}

type ErrorBody = { error?: { code?: string; message?: string; field?: unknown } } | null | undefined;

/**
 * The ApiError for a failed response, from the server's `{error}` body when it
 * sent one. A 401 that survived renewal outside /auth/ ends the session.
 */
function failure(response: Response, path: string, payload: ErrorBody, fallback: string) {
  if (response.status === 401 && !path.startsWith('/auth/'))
    window.dispatchEvent(new Event('session-expired'));
  const error = payload?.error;
  return new ApiError(
    response.status,
    error?.code ?? 'REQUEST_FAILED',
    error?.message ?? fallback,
    typeof error?.field === 'string' ? error.field : undefined,
  );
}

/** A JSON request. Resolves to the body's `data`; 204 resolves to undefined. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await send(path, { ...options, accept: 'application/json' });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw failure(response, path, payload, FAILED);
  if (!payload || !('data' in payload))
    throw new Error('The server returned an unexpected response.');
  if (payload.data?.accessToken) {
    accessToken = payload.data.accessToken;
    csrfToken = payload.data.csrfToken;
  }
  return payload.data as T;
}

/**
 * A text (CSV) download. Errors come back as the usual JSON `{error}` body;
 * any other error body is shown as sent.
 */
export async function apiText(path: string): Promise<string> {
  const response = await send(path, { accept: 'text/csv' });
  const text = await response.text();
  if (!response.ok) {
    let payload: ErrorBody = null;
    try { payload = JSON.parse(text); } catch { /* not JSON: show the text */ }
    throw failure(response, path, payload, text || FAILED);
  }
  return text;
}
export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'Cannot reach the server. Please try again.';
}

async function renew(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      // Read CSRF via same-origin response; refresh credentials remain HttpOnly.
      const session = await api<{csrfToken:string|null}>('/auth/csrf');
      // No refresh session: signed out. Skip the refresh call that could only fail.
      if (!session.csrfToken) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      csrfToken = session.csrfToken;
      await api('/auth/refresh', {method:'POST'});
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        accessToken = null; csrfToken = null;
        window.dispatchEvent(new Event('session-expired'));
      }
      throw error;
    } finally { refreshing = null; }
  })();
  return refreshing;
}
