/**
 * The accounts staff recently opened from the account picker, kept in this browser.
 * Storage is optional: when it is unavailable or full, reads return nothing and
 * writes are skipped, so remembering an account never gets in the way of opening it.
 */
const recentKey = "collaboratory.recentAccounts";
// Names only: this is a shared front-desk browser, so no contact details are kept.
export interface RecentAccount {
  id: number;
  firstName: string;
  lastName: string;
}
export function recentAccounts(): RecentAccount[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentAccount =>
          !!item && typeof item.id === "number" && typeof item.firstName === "string" &&
          typeof item.lastName === "string")
      : [];
  } catch {
    return [];
  }
}
export function rememberAccount({ id, firstName, lastName }: RecentAccount) {
  const next = [{ id, firstName, lastName }, ...recentAccounts().filter((item) => item.id !== id)].slice(0, 5);
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {
    // Best effort: the account is open either way.
  }
}
export function forgetRecentAccounts() {
  try {
    localStorage.removeItem(recentKey);
  } catch {
    // Best effort: nothing was kept if storage is unavailable.
  }
}
