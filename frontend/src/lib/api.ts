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
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const authEntry = ['/auth/login','/auth/register','/auth/demo','/auth/csrf','/auth/refresh','/config'].includes(path);
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
      const session = await api<{csrfToken:string}>('/auth/csrf');
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
