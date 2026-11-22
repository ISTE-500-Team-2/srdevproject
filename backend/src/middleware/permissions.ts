// The guards routes declare at registration: database-configured resource/action grants (own-account
// or global scope chosen by the route), plus the few plain role and signed-in requirements.

import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { AppError } from '../domain.js';
import { authState, requireStaff } from './auth.js';
import { accessGuard } from './accessGuards.js';
import { PermissionModel } from '../models/PermissionModel.js';

// Grants already confirmed for this request, so a route that repeats a prefix gate's check (for
// example /me/billing) asks the database once.
const granted = new WeakMap<Response, Set<string>>();

// Installed per route before controllers. Only server-resolved ownership is accepted.
export function requirePermission(pool: Pool, resource: string, action: string, scope: 'own' | 'global' = 'global') {
  const requirement = `${resource}:${action}:${scope}`;
  return accessGuard(requirement, async (_req: Request, res: Response, next: NextFunction) => {
    const user = authState(res).user;
    if (resource === 'reservation' && action === 'create' && user.roles.includes('instructor'))
      throw new AppError(403,'INSTRUCTOR_BOOKING_FORBIDDEN','Instructor accounts cannot create reservations.');
    if (!granted.get(res)?.has(requirement)) {
      if (!await new PermissionModel(pool).allows(user,resource,action,scope === 'own' ? user.id : null))
        throw new AppError(403,'PERMISSION_REQUIRED','This operation is not permitted for your role.');
      const seen = granted.get(res) ?? new Set<string>();
      seen.add(requirement);
      granted.set(res, seen);
    }
    next();
  });
}

/** Workspace routes: any staff or admin role (checked first, as requireStaff), plus a global grant. */
export function requireStaffPermission(pool: Pool, resource: string, action: string) {
  const permission = requirePermission(pool, resource, action, 'global');
  return accessGuard(`staff & ${resource}:${action}:global`, async (req: Request, res: Response, next: NextFunction) => {
    requireStaff(req, res, () => {});
    await permission(req, res, next);
  });
}

/** The admin role itself, for actions no grant can delegate. `message` is the refusal shown. */
export function requireAdmin(message: string) {
  return accessGuard('admin', (_req: Request, res: Response, next: NextFunction) => {
    if (!authState(res).user.roles.includes('admin'))
      throw new AppError(403, 'ADMIN_REQUIRED', message);
    next();
  });
}

/**
 * Open to every signed-in account; the handler still checks the records it touches (a sponsor
 * link, a class registration). Authentication itself runs once for every route after sign-in.
 */
export const anySignedIn = accessGuard('any signed-in account', (_req: Request, res: Response, next: NextFunction) => {
  if (!res.locals.auth)
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  next();
});
