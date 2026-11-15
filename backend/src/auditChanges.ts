/**
 * Turns an audit record's stored before/after states into the fields a person
 * needs to read: what changed, and what stayed the same.
 *
 * Callers already strip secrets before auditing (card UID hashes, reader keys),
 * but these states are shown to staff, so anything that looks like a credential
 * is dropped here too rather than trusting every caller forever.
 */
export type AuditField = { field: string; before: unknown; after: unknown };
export type AuditChanges = { changed: AuditField[]; unchanged: AuditField[] };

const SECRET = /password|passcode|hash|token|secret|encrypt|signing|credential|private_?key/i;
// A revision number moves on every save. It is bookkeeping, not a change anyone made.
const BOOKKEEPING = /^(revision|.*_revision|.*Revision)$/;

// Nested objects (a profile's address, contact preferences) can hold keys nobody vetted,
// so secrets are dropped at every depth, not just at the top.
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !SECRET.test(key)).map(([key, inner]) => [key, redact(inner)]),
    );
  return value;
}

function fields(state: unknown): Record<string, unknown> | null {
  if (state == null) return null;
  const clean = redact(state);
  if (typeof clean === "object" && !Array.isArray(clean)) return clean as Record<string, unknown>;
  return { value: clean };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Null when the record kept no states (every database-trigger row, and some actions). */
export function auditChanges(before: unknown, after: unknown): AuditChanges | null {
  const was = fields(before);
  const now = fields(after);
  if (!was && !now) return null;
  const keys = [...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])].filter(
    (key) => !SECRET.test(key) && !BOOKKEEPING.test(key),
  );
  const changed: AuditField[] = [];
  const unchanged: AuditField[] = [];
  for (const field of keys) {
    const entry = { field, before: was?.[field] ?? null, after: now?.[field] ?? null };
    if (!same(entry.before, entry.after)) changed.push(entry);
    // A newly created record has nothing that "stayed the same": empty fields are left out.
    else if (was && now) unchanged.push(entry);
  }
  return { changed, unchanged };
}
