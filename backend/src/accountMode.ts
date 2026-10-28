import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { AppError, publicUser, type UserView } from "./domain.js";
import { transaction } from "./db.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { SessionModel } from "./models/SessionModel.js";
import { UserModel } from "./models/UserModel.js";

const isWorkspaceRole = (role: string) => role === "staff" || role === "admin";
const isProtectedRole = (role: string) =>
  isWorkspaceRole(role) || role === "instructor";

/** Express matches routes case-insensitively and ignores a trailing slash. */
const normalize = (path: string) => path.toLowerCase().replace(/\/+$/, "") || "/";

/**
 * Staff tools keep running as the staff member while a member's account is open.
 * The open account lives on the sign-in, so a workspace tab next to an account
 * tab must still reach these as staff (/training backs the member search box).
 */
const workspacePrefixes = ["/admin", "/billing-management", "/studio-management", "/training"];
export const isWorkspacePath = (path: string) => {
  const normalized = normalize(path);
  return workspacePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
};

/**
 * Why `actor` may not open `subject`'s account, or null when they may.
 * Opening a staff, instructor or admin account would hand over that person's
 * permissions, so only plain member accounts (or your own) can be opened.
 */
export function accountModeRefusal(actor: UserView, subject: UserView | null): string | null {
  if (!actor.roles.some(isWorkspaceRole)) return "Staff permission is required.";
  if (!subject) return "That account no longer exists.";
  if (subject.status !== "active" || subject.accessStatus !== "active")
    return "That account is suspended or restricted, so it can't be opened.";
  if (subject.id !== actor.id && subject.roles.some(isProtectedRole))
    return "Staff, instructor and admin accounts can't be opened from the workspace.";
  return null;
}

/**
 * The only changes staff may make in someone else's account: the member actions
 * account mode exists for. Everything else that writes is refused, so member
 * routes added later stay closed until someone decides they belong here. Reads
 * stay open (staff can already read member records), except where a route
 * guard below says otherwise.
 */
const allowedWhileActing: RegExp[] = [
  /^\/reservations$/,
  /^\/reservations\/\d+\/cancel$/,
  /^\/me\/check-ins$/,
  /^\/classes\/\d+\/(enroll|withdraw)$/,
  /^\/studio-rentals$/,
  /^\/studio-rentals\/\d+\/(cancel|payment-status)$/,
  /^\/me\/billing\/(checkout|free-membership)$/,
  /^\/me\/billing\/passes\/checkout$/,
  /^\/me\/billing\/[^/]+\/cancel$/,
  /^\/me\/billing\/passes\/[^/]+\/cancel$/,
  /^\/auth\/logout$/,
];
const isRead = (method: string) => method === "GET" || method === "HEAD";

/** Fail closed: anything that writes and isn't a listed member action is refused. */
export function assertAllowedWhileActing(req: Request, actor: UserView, subject: UserView) {
  if (actor.id === subject.id || isRead(req.method)) return;
  const path = normalize(req.path);
  if (!allowedWhileActing.some((pattern) => pattern.test(path)))
    throw new AppError(403, "NOT_IN_ACCOUNT_MODE", "That isn't available while you're in someone else's account.");
}

/**
 * Refuse a route while staff are acting in someone else's account. Attached to
 * the routes themselves, after Express has matched them, so path spelling
 * (case, trailing slashes) can't route around it. Gives a specific reason and
 * also covers reads, which the write allowlist above lets through.
 */
export function forbidWhileActing(message: string, options: { adminMay?: boolean; code?: string } = {}) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const { user, actor } = authState(res);
    if (actor && actor.id !== user.id && !(options.adminMay && actor.roles.includes("admin")))
      throw new AppError(403, options.code ?? "NOT_IN_ACCOUNT_MODE", message);
    next();
  };
}
export const signatureIsMemberOnly = forbidWhileActing(
  "Waivers have to be signed by the member, signed in to their own account.",
);
export const settingsAreMemberOnly = forbidWhileActing(
  "Change these from the member's record in the staff workspace.",
);
export const paymentDetailsAreMemberOnly = forbidWhileActing(
  "Payment details are managed by the member, signed in to their own account.",
);
// Signed waiver copies are admin-only in the workspace; don't widen that here.
export const waiverCopiesAreAdminOnly = forbidWhileActing(
  "Only administrators can open signed waiver copies.",
  { adminMay: true, code: "ADMIN_REQUIRED" },
);

export function accountModeView(user: UserView, actor?: UserView) {
  return { user: publicUser(user), actingAs: actor ? { actor: publicUser(actor) } : null };
}

export function accountModeRoutes(pool: Pool, config: AppConfig) {
  const routes = Router();
  routes.post("/admin/account-mode", requireCsrf, async (req, res) => {
    const userId = Number(req.body.userId);
    if (!Number.isSafeInteger(userId) || userId < 1)
      throw new AppError(400, "INVALID_INPUT", "Choose a member account to open.");
    const { user: actor, token, csrfToken } = authState(res);
    const subject = await new UserModel(pool).findById(userId);
    const refusal = accountModeRefusal(actor, subject);
    if (refusal) throw new AppError(subject ? 403 : 404, "ACCOUNT_MODE_REFUSED", refusal);
    await transaction(pool, async (db) => {
      await new SessionModel(db, config.jwtKey, config.accessTokenSeconds, config.refreshTokenSeconds)
        .setActingAs(token, subject!.id);
      await db.query(
        `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason) VALUES($1,$2,'account_mode.opened','user',$2,'Opened from the staff workspace')`,
        [actor.id, subject!.id],
      );
    });
    res.set("Cache-Control", "no-store");
    res.json({ data: { ...accountModeView(subject!, actor), csrfToken } });
  });
  routes.post("/admin/account-mode/end", requireCsrf, async (_req, res) => {
    const { user: actor, token, csrfToken } = authState(res);
    await transaction(pool, async (db) => {
      const sessions = new SessionModel(db, config.jwtKey, config.accessTokenSeconds, config.refreshTokenSeconds);
      const open = await sessions.find(token);
      await sessions.setActingAs(token, null);
      if (open?.actingAsUserId)
        await db.query(
          `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason) VALUES($1,$2,'account_mode.closed','user',$2,'Returned to the staff workspace')`,
          [actor.id, open.actingAsUserId],
        );
    });
    res.set("Cache-Control", "no-store");
    res.json({ data: { ...accountModeView(actor), csrfToken } });
  });
  return routes;
}
