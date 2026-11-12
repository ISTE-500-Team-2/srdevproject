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
