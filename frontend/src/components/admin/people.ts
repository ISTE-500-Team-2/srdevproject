/** Small display helpers shared by the workspace and account mode. */

/** Where "Back to workspace" returns to. */
export const lastWorkspacePathKey = "collaboratory.lastWorkspacePath";
export const initials = (first?: string, last?: string) =>
  `${(first ?? "").trim().charAt(0)}${(last ?? "").trim().charAt(0)}`.toUpperCase() || "?";

/** The role a person works in, for labels like "as an Admin". */
export const roleLabel = (person: { roles: string[] }) =>
  person.roles.includes("admin") ? "Admin" : person.roles.includes("staff") ? "Staff" : "Member";

/** Accounts staff may not open: they would carry staff, instructor or admin permissions. */
export const isProtectedAccount = (person: { roles: string[] }) =>
  person.roles.some((role) => role === "admin" || role === "staff" || role === "instructor");

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
  localStorage.setItem(recentKey, JSON.stringify(next));
}
export const forgetRecentAccounts = () => localStorage.removeItem(recentKey);
