/**
 * Identifies an error for logs without its message or payload: the error class plus a
 * PostgreSQL SQLSTATE or Stripe error type. Anything that is not a short identifier is dropped.
 */
export function errorIdentifier(error: unknown) {
  const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined;
  const object = typeof error === 'object' && error !== null ? error as { code?: unknown; type?: unknown } : undefined;
  return { error: safe(object?.constructor?.name) ?? typeof error, code: safe(object?.code), type: safe(object?.type) };
}
