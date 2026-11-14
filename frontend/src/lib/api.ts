// Shared authenticated transport: access/CSRF tokens stay in memory, refresh credentials stay in
// HttpOnly cookies and 401s retry once.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
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
/** Send an authenticated JSON request, renew once on 401 and unwrap the API's data/error envelope. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const authEntry = ['/auth/login','/auth/register','/auth/confirm','/auth/confirmation','/auth/password-reset','/auth/password-reset/check','/auth/password-reset/confirm','/auth/demo','/auth/csrf','/auth/refresh','/config'].includes(path);
  if (!accessToken && !authEntry) await renew();
  const method = options.method ?? 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  const perform = () => fetch('/api' + path, {
    method,
    credentials: 'include',
    signal: options.signal,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? {Authorization: `Bearer ${accessToken}`} : {}),
      ...(mutation ? { 'Content-Type': 'application/json' } : {}),
      ...(mutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  let response = await perform();
  if (response.status === 401 && !authEntry) {
    await renew();
    response = await perform();
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? 'The request could not be completed.',
    );
  }
  if (!payload || !('data' in payload))
    throw new Error('The server returned an unexpected response.');
  if (payload.data?.accessToken) {
    accessToken = payload.data.accessToken;
    csrfToken = payload.data.csrfToken;
  }
  return payload.data as T;
}
/** Use the same session renewal for CSV/text downloads without expecting the JSON data envelope. */
export async function apiText(path: string): Promise<string> {
  if (!accessToken) await renew();
  const perform = () =>
    fetch("/api" + path, {
      credentials: "include",
      headers: {
        Accept: "text/csv",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });
  let response = await perform();
  if (response.status === 401) {
    await renew();
    response = await perform();
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, "REQUEST_FAILED", text || "The request could not be completed.");
  }
  return text;
}
export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'Cannot reach the server. Please try again.';
}

/**
 * Share one refresh promise across concurrent reads so they do not race to consume the same
 * single-use refresh cookie.
 */
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
