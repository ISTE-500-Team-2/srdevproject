// Resolves signed-in identity, account mode and CSRF checks. Browser origin validation and bounded
// sign-in throttling are separate layers.

import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { auditContext } from "../auditContext.js";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { AppError, type UserView } from "../domain.js";
import { SessionModel } from "../models/SessionModel.js";
import { UserModel } from "../models/UserModel.js";
import { accountModeRefusal, assertAllowedWhileActing, isWorkspacePath } from "../accountMode.js";

export const cookieName = "arbor_refresh";
/**
 * The refresh cookie, or "" when there is none. Ours is host-only, so a browser holds one. A second
 * copy can only come from another site under the same parent domain (cookie tossing), and browsers
 * send its longer path first, so a request carrying more than one is treated as signed out rather
 * than letting the planted cookie choose whose session this is.
 */
export function refreshToken(req: Request): string {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0]!.slice(cookieName.length + 1) : "";
}
export function sessionToken(req: Request): string {
  const header = req.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
export interface AuthState {
  /** Whose account the request acts on: the open member account, or the signed-in person. */
  user: UserView;
  /** The staff member who opened `user`'s account, when one is open. */
  actor?: UserView;
  csrfToken: string;
  token: string;
}
export const authState = (res: Response): AuthState =>
  res.locals.auth as AuthState;

export function requireStaff(_req: Request, res: Response, next: NextFunction) {
  const user = authState(res).user;
  const hasStaffOrAdminRole =
    Array.isArray(user.roles) &&
    user.roles.some((role) => role === "staff" || role === "admin");

  if (!hasStaffOrAdminRole)
    throw new AppError(403, "STAFF_REQUIRED", "Staff permission is required.");
  next();
}

/** A request that writes to whichever account it runs as. Signing out ends the sign-in itself. */
const changesAccount = (req: Request) =>
  !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
  req.path.toLowerCase().replace(/\/+$/, "") !== "/auth/logout";

/**
 * Resolve current session/account data on every request, then bind the real operator separately
 * from any member being assisted.
 */
export function requireUser(pool: Pool, config: AppConfig) {
  const sessions = new SessionModel(
    pool,
    config.jwtKey,
    config.accessTokenSeconds,
    config.refreshTokenSeconds,
  );
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = sessionToken(req);
    const session = await sessions.find(token);
    const user = session
      ? await new UserModel(pool, config.timeZone).findById(session.userId)
      : null;
    if (!session || !user)
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (user.status !== "active")
      throw new AppError(
        403,
        "ACCOUNT_INACTIVE",
        "This account does not currently have access. Please see staff.",
      );
    let subject = user;
    const workspace = isWorkspacePath(req.path);
    if (session.actingAsUserId && !workspace) {
      const opened = await new UserModel(pool, config.timeZone).findById(session.actingAsUserId);
      // Re-check every request: roles, suspensions and restrictions change.
      const refusal = accountModeRefusal(user, opened);
      if (refusal) {
        await sessions.setActingAs(token, null);
        // A change meant for the member must never quietly land on the staff member's own account.
        if (changesAccount(req))
          throw new AppError(409, "ACCOUNT_MODE_CLOSED", `The account you were working in was closed, so nothing was changed. ${refusal}`);
      } else subject = opened!;
    }
    // The page names the account it is showing. The open account lives on the sign-in, so another
    // tab may have opened, switched or closed one since; refuse rather than change someone else's.
    const shown = req.get("X-Account-Subject");
    if (shown && !workspace && changesAccount(req) && shown !== String(subject.id))
      throw new AppError(409, "ACCOUNT_CHANGED",
        "A different account is open now than the one this page was showing, so nothing was changed. Check whose account you're in and try again.");
    if (subject !== user) assertAllowedWhileActing(req, user, subject);
    res.locals.auth = {
      user: subject,
      ...(subject !== user ? { actor: user } : {}),
      csrfToken: session.csrfToken,
      token,
    } satisfies AuthState;
    // Audit rows always name the person at the keyboard.
    const context = auditContext.getStore();
    if (context) {
      context.actorId = user.id;
      if (subject !== user) context.actingForId = subject.id;
    }
    next();
  };
}

/**
 * Compare the browser's CSRF header with its session value without timing-dependent string
 * comparison.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const expected = Buffer.from(authState(res).csrfToken);
  const actual = Buffer.from(req.get("X-CSRF-Token") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AppError(403, "CSRF_INVALID", "Refresh the page and try again.");
  next();
}

/**
 * For browser mutations, require an allowed origin/site and a JSON object body before dispatching
 * to feature handlers.
 */
export function checkOrigin(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("Origin");
      if (
        (origin && !config.allowedOrigins.includes(origin)) ||
        req.get("Sec-Fetch-Site") === "cross-site"
      ) {
        throw new AppError(
          403,
          "ORIGIN_FORBIDDEN",
          "This request origin is not allowed.",
        );
      }
      if (!req.is("application/json"))
        throw new AppError(
          415,
          "JSON_REQUIRED",
          "Send an application/json request.",
        );
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        throw new AppError(400, "INVALID_INPUT", "Send a JSON object.");
    }
    next();
  };
}

/**
 * The budget a client address falls in. An IPv6 visitor usually holds a whole /64 and can pick
 * any address in it, so the /64 shares one budget. IPv4 (IPv4-mapped too) counts by address.
 */
export function addressBudget(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.replace(/%.*$/, "").toLowerCase();
  if (isIP(address) !== 6 || address.includes(".")) return address;
  const [head = "", tail] = address.split("::");
  const groups = head ? head.split(":") : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(":") : [];
    groups.push(...Array<string>(8 - groups.length - rest.length).fill("0"), ...rest);
  }
  const prefix = groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16));
  // ::/64 holds loopback and the IPv4-mapped forms: single hosts, not one visitor's block.
  return prefix.every((group) => group === "0") ? address : `${prefix.join(":")}::/64`;
}

/**
 * Create a bounded, process-local attempt budget. Give each route its own instance, so one
 * endpoint's traffic never spends another's allowance. Budgets are per client address (req.ip,
 * which is the visitor only when 'trust proxy' names the proxies in front of the app; an IPv6
 * /64 counts as one address); `key` narrows one further, for example to one account from one
 * address, or with `perAddress: false` names the budget on its own, across every address. With
 * `failuresOnly`, only requests that fail count: one that succeeds hands its attempt back, so
 * ordinary sign-ins and session renewals never use up anyone's allowance, and so does a request
 * a budget refused (429), so retrying while limited never spends another budget on the route.
 * Attempts still count while in flight, so parallel guesses can't overrun the limit.
 */
export function authRateLimit(
  options: {
    limit?: number;
    windowMs?: number;
    message?: string;
    key?: (req: Request, res: Response) => string;
    perAddress?: boolean;
    failuresOnly?: boolean;
  } = {},
) {
  const limit = options.limit ?? 30;
  const windowMs = options.windowMs ?? 15 * 60000;
  const attempts = new Map<string, { count: number; until: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const address = addressBudget(req.ip);
    const narrowed = options.key?.(req, res);
    const key = narrowed === undefined ? address
      : options.perAddress === false ? narrowed : `${address}\n${narrowed}`;
    let record = attempts.get(key);
    if (!record) {
      // A full table forgets its oldest entry; refusing every newcomer would lock out the site.
      if (attempts.size >= 2048) attempts.delete(attempts.keys().next().value!);
      record = { count: 0, until: now + windowMs };
      attempts.set(key, record);
    }
    record.count++;
    if (options.failuresOnly) {
      const counted = record;
      res.once("finish", () => {
        if (res.statusCode >= 400 && res.statusCode !== 429) return;
        counted.count--;
        if (counted.count <= 0 && attempts.get(key) === counted) attempts.delete(key);
      });
    }
    if (record.count > limit) {
      res.set("Retry-After", String(Math.ceil((record.until - now) / 1000)));
      throw new AppError(
        429,
        "RATE_LIMITED",
        options.message ?? "Too many sign-in attempts. Please try again later.",
      );
    }
    next();
  };
}
