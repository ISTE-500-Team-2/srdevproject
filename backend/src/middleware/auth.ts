import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { AppError, type UserView } from "../domain.js";
import { SessionModel } from "../models/SessionModel.js";
import { UserModel } from "../models/UserModel.js";

export const cookieName = "arbor_session";
export function sessionToken(req: Request): string {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? ""
  );
}
export interface AuthState {
  user: UserView;
  csrfToken: string;
  token: string;
}
export const authState = (res: Response): AuthState =>
  res.locals.auth as AuthState;

export function requireStaff(_req: Request, res: Response, next: NextFunction) {
  const user = authState(res).user;
  const hasStaffOrAdminRole = Array.isArray(user.roles)
    && user.roles.some((role) => role === "staff" || role === "admin");

  if (!hasStaffOrAdminRole)
    throw new AppError(403, "STAFF_REQUIRED", "Staff permission is required.");
  next();
}

export function requireUser(pool: Pool, config: AppConfig) {
  const sessions = new SessionModel(pool, config.jwtKey);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = sessionToken(req);
    const session = await sessions.find(token);
    const user = session
      ? await new UserModel(pool).findById(session.userId)
      : null;
    if (!session || !user)
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (user.status !== "active")
      throw new AppError(
        403,
        "ACCOUNT_INACTIVE",
        "This account does not currently have access.",
      );
    res.locals.auth = {
      user,
      csrfToken: session.csrfToken,
      token,
    } satisfies AuthState;
    next();
  };
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const expected = Buffer.from(authState(res).csrfToken);
  const actual = Buffer.from(req.get("X-CSRF-Token") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AppError(403, "CSRF_INVALID", "Refresh the page and try again.");
  next();
}

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

export function authRateLimit() {
  const attempts = new Map<string, { count: number; until: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const key = req.ip ?? "unknown";
    const record = attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (attempts.size >= 2048 && !attempts.has(key))
      throw new AppError(429, "RATE_LIMITED", "Please try again later.");
    record.count++;
    attempts.set(key, record);
    if (record.count > 30) {
      res.set("Retry-After", String(Math.ceil((record.until - now) / 1000)));
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many sign-in attempts. Please try again later.",
      );
    }
    next();
  };
}
