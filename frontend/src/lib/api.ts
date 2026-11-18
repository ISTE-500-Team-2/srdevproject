// Shared authenticated transport: access/CSRF tokens stay in memory, refresh credentials stay in
// HttpOnly cookies and 401s retry once.

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
// Who `accessToken` was issued to. Every tab shares one refresh cookie, so a
// renewal answers for whoever signed in on this browser last.
let tokenOwner: number | null = null;
export function setAccessToken(value: string | null) { accessToken = value; if (!value) tokenOwner = null; }
let refreshing: Promise<void> | null = null;
let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}
// Whose account this tab is showing. Changes carry it, so a server whose open account has
// since changed (in another tab, say) refuses them instead of changing someone else's.
let accountSubject: number | null = null;
export function setAccountSubject(value: number | null) { accountSubject = value; }
// Sign-in, recovery and public config requests work without a session: they
// never renew it first or retry after a 401.
const SESSIONLESS = new Set(['/auth/login','/auth/register','/auth/confirm','/auth/confirmation','/auth/password-reset','/auth/password-reset/check','/auth/password-reset/confirm','/auth/email-change/confirm','/auth/demo','/auth/csrf','/auth/refresh','/config']);
const FAILED = 'The request could not be completed.';

/**
 * The one authenticated transport behind api() and apiText(): renews a missing
 * access token first, sends the bearer token, cookies and, for mutations, the
 * JSON body and CSRF token, and after a 401 renews once and retries (unless the
 * renewal comes back signed in as someone else). The caller decodes the response.
 */
async function send(
  path: string,
  { method = 'GET', body, signal, accept }: { method?: string; body?: unknown; signal?: AbortSignal; accept: string },
): Promise<Response> {
  const sessionless = SESSIONLESS.has(path);
  const owner = tokenOwner;
  // Keep the account shown when the action started, even if the page changes during renewal.
  const subject = accountSubject;
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
      ...(mutation && subject !== null ? { 'X-Account-Subject': String(subject) } : {}),
    },
    ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  let response = await perform();
  if (response.status === 401 && !sessionless) {
    await renew();
    // Someone else signed in from another tab: never send this tab's request as them.
    if (owner !== null && tokenOwner !== owner) throw signedInElsewhere();
    response = await perform();
  }
  return response;
}

/** This tab's sign-in was replaced by another person's: drop it and go back to sign-in. */
function signedInElsewhere() {
  accessToken = null; csrfToken = null; tokenOwner = null;
  window.dispatchEvent(new Event('session-expired'));
  return new ApiError(401, 'SIGNED_IN_ELSEWHERE', 'Someone else signed in on this browser, so you were signed out here. Sign in again to continue.');
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
  // The open account changed under this tab: show the account that is open now.
  if (error?.code === 'ACCOUNT_CHANGED' || error?.code === 'ACCOUNT_MODE_CLOSED')
    window.dispatchEvent(new Event('account-changed'));
  // A gateway answering for an app that is down or restarting has no app error to give.
  const unreachable = [502, 503, 504].includes(response.status) && !error?.message;
  return new ApiError(
    response.status,
    error?.code ?? (unreachable ? 'SERVER_UNREACHABLE' : 'REQUEST_FAILED'),
    error?.message ?? (unreachable ? unreachableMessage : fallback),
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
    tokenOwner = payload.data.user?.id ?? null;
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
/** The message for a request that never got an answer from the server. */
export const unreachableMessage = 'Cannot reach the server. Please try again.';
export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : unreachableMessage;
}

/**
 * Every request waits on one shared renewal, so a renewal that never answers would hold
 * them all (and every retry of a failed page). The CSRF read is safe to abandon and
 * repeat, so it is bounded. The refresh POST is not: the server rotates the refresh
 * token and forgives a second use for only a few seconds before treating it as replay
 * and revoking the session, so it is never cut short or re-sent while pending. A
 * refresh that stalls therefore keeps its callers, and other tabs' renewals, waiting
 * with no app deadline: a known limit of the current protocol, which only idempotent
 * rotation on the server would lift.
 */
const csrfReadTimeoutMs = 10_000;
async function readCsrf() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The server did not answer in time.'));
    }, csrfReadTimeoutMs);
  });
  try {
    return await Promise.race([api<{csrfToken:string|null}>('/auth/csrf', { signal: controller.signal }), timeout]);
  } finally { clearTimeout(timer); }
}

/**
 * Tabs share one refresh cookie and each renewal rotates it, so tabs renew one at a time:
 * each then sends the cookie the previous renewal set, never the same one at once.
 * Browsers without Web Locks (or plain-HTTP pages) rely on the server's grace window.
 */
function oneTabAtATime(renewal: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request('arbor-session-renewal', renewal) : renewal();
}

async function renew(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await oneTabAtATime(async () => {
        // Read CSRF via same-origin response; refresh credentials remain HttpOnly.
        const session = await readCsrf();
        // No refresh session: signed out. Skip the refresh call that could only fail.
        if (!session.csrfToken) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
        csrfToken = session.csrfToken;
        await api('/auth/refresh', {method:'POST'});
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        accessToken = null; csrfToken = null; tokenOwner = null;
        window.dispatchEvent(new Event('session-expired'));
      }
      throw error;
    } finally { refreshing = null; }
  })();
  return refreshing;
}
