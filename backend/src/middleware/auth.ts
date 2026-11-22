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
import { accountModeRefusal, assertAllowedWhileActing, isWorkspacePath, isWorkspaceRole } from "../accountMode.js";
import { accessGuard } from "./accessGuards.js";

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

/** Any staff or admin role. Also mounted on the whole /admin prefix, as a second line of defense. */
export const requireStaff = accessGuard("staff", function requireStaff(_req: Request, res: Response, next: NextFunction) {
  const user = authState(res).user;
  const hasStaffOrAdminRole =
    Array.isArray(user.roles) &&
    user.roles.some(isWorkspaceRole);

  if (!hasStaffOrAdminRole)
    throw new AppError(403, "STAFF_REQUIRED", "Staff permission is required.");
  next();
});

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
  return accessGuard("signed in", async (req: Request, res: Response, next: NextFunction) => {
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
    const accountChange = !workspace && changesAccount(req);
    if (session.actingAsUserId && !workspace) {
      const opened = await new UserModel(pool, config.timeZone).findById(session.actingAsUserId);
      // Re-check every request: roles, suspensions and restrictions change.
      const refusal = accountModeRefusal(user, opened);
      if (refusal) {
        await sessions.setActingAs(token, null);
        // A change meant for the member must never quietly land on the staff member's own account.
        if (accountChange)
          throw new AppError(409, "ACCOUNT_MODE_CLOSED", `The account you were working in was closed, so nothing was changed. ${refusal}`);
      } else subject = opened!;
    }
    // The page names the account it is showing. The open account lives on the sign-in, so another
    // tab may have opened, switched or closed one since; refuse rather than change someone else's.
    const shown = req.get("X-Account-Subject");
    if (accountChange && shown && shown !== String(subject.id))
      throw new AppError(409, "ACCOUNT_CHANGED",
        "A different account is open now than the one this page was showing, so nothing was changed. Check whose account you're in and try again.");
    if (subject !== user) assertAllowedWhileActing(req, user, subject);
    // A tab with an older frontend might omit the subject even after another tab closed account mode.
    if (accountChange && !shown && user.roles.some(isWorkspaceRole))
      throw new AppError(409, "ACCOUNT_SUBJECT_REQUIRED",
        "Reload this page, check whose account you're in, and try again. Nothing was changed.");
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
  });
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

/** The eight 16-bit groups of a valid IPv6 address (lowercase, no zone), dotted IPv4 tail included. */
function ipv6Groups(address: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? address.slice(0, dotted.index) +
      `${((Number(dotted[1]) << 8) | Number(dotted[2])).toString(16)}:${((Number(dotted[3]) << 8) | Number(dotted[4])).toString(16)}`
    : address;
  const [head = "", tail] = text.split("::");
  const groups = head ? head.split(":") : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(":") : [];
    groups.push(...Array<string>(8 - groups.length - rest.length).fill("0"), ...rest);
  }
  return groups.map((group) => parseInt(group, 16));
}

/** Unspecified, private (RFC 1918), carrier-grade NAT, loopback or link-local IPv4. */
function nonPublicIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
}

/**
 * The budget a client address falls in, or undefined when the visitor's real address is unknown:
 * missing, loopback, private, carrier-grade NAT, link-local or unique-local. Those name a proxy, a
 * Docker bridge or a network seen from inside, so one of them can stand for many people (behind a
 * proxy that hides visitors, the whole site), and counting it would let a few bad attempts lock
 * them all out. An IPv6 visitor can pick any address in the block their connection is given,
 * often a /56 (256 /64s) at home, so a /56 shares one budget. IPv4 counts by address, written
 * plainly or IPv4-mapped.
 */
export function addressBudget(ip: string | undefined): string | undefined {
  const address = (ip ?? "").replace(/%.*$/, "").toLowerCase();
  const family = isIP(address);
  if (family === 4) return nonPublicIPv4(address) ? undefined : address;
  if (family !== 6) return undefined;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const ipv4 = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
    return nonPublicIPv4(ipv4) ? undefined : ipv4;
  }
  // Unspecified (::) and loopback (::1); unique-local fc00::/7; link-local fe80::/10 and the
  // retired site-local fec0::/10.
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7]! <= 1) return undefined;
  if ((groups[0]! & 0xfe00) === 0xfc00 || (groups[0]! & 0xff80) === 0xfe80) return undefined;
  // The first 56 bits: three groups and the top half of the fourth.
  const prefix = groups.slice(0, 4).map((group, i) => group & (i === 3 ? 0xff00 : 0xffff));
  // The rest of ::/56 holds single-host forms (IPv4-compatible), not one visitor's block.
  return prefix.every((group) => group === 0) ? address : `${prefix.map((group) => group.toString(16)).join(":")}::/56`;
}

/** The most entries one budget holds, so memory stays bounded however many keys arrive. */
export const maxBudgetEntries = 2048;

/**
 * Create a bounded, process-local attempt budget. Give each route its own instance, so one
 * endpoint's traffic never spends another's allowance. Without `key`, the budget is per client
 * address (req.ip, which is the visitor only when 'trust proxy' names the proxies in front of the
 * app; an IPv6 /56 counts as one address). `key` names an identifier, such as one account, and
 * narrows the budget to that identifier from that address; with `perAddress: false` it names the
 * budget on its own, across every address. No budget is ever shared by everyone: when the
 * visitor's address is unknown (see addressBudget) an address budget does not apply, and an
 * address-and-identifier budget counts the identifier alone. A request without an identifier
 * (`key` returns "") is counted by address only. With `failuresOnly`, only requests that fail
 * count: one that succeeds hands its attempt back, so ordinary sign-ins and session renewals
 * never use up anyone's allowance, and so does a request a budget refused (429), so retrying
 * while limited never spends another budget on the route. Attempts still count while in flight,
 * so parallel guesses can't overrun the limit.
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
  /** This request's entry, or undefined when no budget applies (its address is unknown). */
  const budgetKey = (req: Request, res: Response) => {
    const address = addressBudget(req.ip);
    const identifier = options.key?.(req, res) || undefined;
    if (identifier === undefined)
      return address === undefined || (options.key && options.perAddress === false) ? undefined : `@${address}`;
    return address === undefined || options.perAddress === false ? `#${identifier}` : `@${address}\n${identifier}`;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const key = budgetKey(req, res);
    if (key === undefined) return next();
    let record = attempts.get(key);
    if (!record) {
      // A full table forgets the entry with the fewest attempts (the oldest of those); refusing
      // every newcomer would lock out the site. Never simply the oldest: anyone could flood the
      // table with fresh keys to wipe the count they are trying to get past.
      if (attempts.size >= maxBudgetEntries) {
        let fewest: string | undefined, least = Infinity;
        for (const [entry, value] of attempts)
          if (value.count < least) { fewest = entry; least = value.count; }
        attempts.delete(fewest!);
      }
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
