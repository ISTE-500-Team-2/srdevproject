// Navigation context only: never payment evidence or authorization.
const key = 'arbor-assisted-checkout-return';
export function rememberAssistedReturn(actorId: number | undefined, memberId: number) {
  try { sessionStorage.setItem(key, JSON.stringify({ actorId, memberId, at: Date.now() })); } catch { /* Storage may be disabled. */ }
}
export function forgetAssistedReturn() {
  try { sessionStorage.removeItem(key); } catch { /* Optional browser state. */ }
}
export function legacyAssistedMember(actorId: number | undefined): number | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return saved?.actorId === actorId && Number.isSafeInteger(saved.memberId) && saved.memberId > 0 &&
      saved.at <= Date.now() && Date.now() - saved.at < 24 * 3600_000 ? saved.memberId : null;
  } catch { return null; }
}
