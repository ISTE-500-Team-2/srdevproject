export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  const response = await fetch('/api' + path, {
    method,
    credentials: 'include',
    signal: options.signal,
    headers: {
      Accept: 'application/json',
      ...(mutation ? { 'Content-Type': 'application/json' } : {}),
      ...(mutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
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
  return payload.data as T;
}
export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'Cannot reach the server. Please try again.';
}
