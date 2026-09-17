import type { NextFunction, Request, Response } from 'express';

export const PERMISSION_ID_TO_NAME: Record<number, string> = {1: 'create', 2: 'read', 3: 'update', 4: 'delete'};
export const PROTECTED_MANAGEMENT_TABLES = new Set(['role', 'permission', 'role_permission', 'user_role']);
type Actor = { id: number; roles?: string[] } | null;
export function userHasRole(user: Actor, role: string): boolean {
  return !!user?.roles?.includes(role);
}
export function canReadUser(user: Actor, ownerId: number): boolean {
  return !!user && Number.isSafeInteger(ownerId) && ownerId > 0 && user.id === ownerId;
}
// Rules and ownership must come from the database, never the request body.
export function authorize({user, rules = [], resourceName, action = 'read', ownerId = null}: {
  user: Actor; rules?: Array<Record<string, unknown>>; resourceName: string;
  action?: string; ownerId?: number | string | null;
}): boolean {
  if (!user || !resourceName || !Object.values(PERMISSION_ID_TO_NAME).includes(action)) return false;
  if (userHasRole(user, 'admin')) return true;
  if (PROTECTED_MANAGEMENT_TABLES.has(resourceName) && action !== 'read') return false;
  const matching = rules.filter(row => user?.roles?.includes(String(row.roleName)) &&
    row.permissionName === action && (row.resourceName === resourceName || row.resourceName === 'all_tables') &&
    (row.scopeType === 'global' || (row.scopeType === 'personal' &&
      ownerId !== null && canReadUser(user, Number(ownerId)))));
  // An applicable explicit deny wins over grants, including grants from other roles.
  return !matching.some(row => row.isAllowed === false) && matching.some(row => row.isAllowed === true);
}
export function requireAdmin(_req: Request, res: Response, next: NextFunction): unknown {
  if (!userHasRole(res.locals.auth?.user, 'admin'))
    return res.status(403).json({error: 'Administrator permission is required.'});
  return next();
}
// A route must resolve the persisted record and set res.locals.resourceOwnerId first.
export function requireOwnershipOrAdmin(_req: Request, res: Response, next: NextFunction): unknown {
  const user = res.locals.auth?.user;
  if (userHasRole(user, 'admin') || canReadUser(user, res.locals.resourceOwnerId)) return next();
  return res.status(403).json({error: 'Ownership required for personal scope access.'});
}
