/**
 * Server settings that are the same for every visitor and account (/config),
 * kept for `useApi(path, { reuse: true })` readers so pages that need the time
 * zone render without waiting a round trip for it. Nothing private is stored.
 */
const stored = new Map<string, unknown>();

export function readStored<T>(path: string): { data: T } | undefined {
  return stored.has(path) ? { data: stored.get(path) as T } : undefined;
}

export function storeResult(path: string, data: unknown) {
  stored.set(path, data);
}

/** Tests only: start from an empty store. */
export function clearStoredSettingsForTests() {
  stored.clear();
}
