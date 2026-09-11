import type { NextFunction, Request, Response } from 'express';

const PERMISSION_ID_TO_NAME: Record<number, string> = {
  1: 'create',
  2: 'read',
  3: 'update',
  4: 'delete',
};

const PROTECTED_MANAGEMENT_TABLES = new Set([
  'role',
  'permission',
  'role_permission',
  'user_role',
]);

const ROLE_BASED_DATA_PROTECTION = {
  waiver: { resourceName: 'waiver', scopeType: 'role-based', roles: ['admin', 'staff'] },
  training: { resourceName: 'training', scopeType: 'role-based', roles: ['admin', 'staff'] },
};

function userHasRole(user: { roles?: Array<string> } | null, wantedRole: string): boolean {
  if (!user || !Array.isArray(user.roles)) {
    return false;
  }

  return user.roles.some((role) => String(role) === String(wantedRole));
}

function canReadUser(user: { userID?: number } | null, targetUserId: number): boolean {
  return Boolean(user && Number(user.userID) === Number(targetUserId));
}

function authorize({
  user,
  rules = [],
  resourceName,
  action = 'read',
  scopeType = 'personal',
  ownerId = null,
  requestUserId = null,
}: {
  user: { userID?: number; roles?: Array<string> } | null;
  rules?: Array<Record<string, unknown>>;
  resourceName: string;
  action?: string;
  scopeType?: string;
  ownerId?: number | string | null;
  requestUserId?: number | string | null;
}): boolean {
  if (!user) {
    return false;
  }

  if (PROTECTED_MANAGEMENT_TABLES.has(resourceName) && !['read'].includes(action)) {
    if (!userHasRole(user, 'admin')) {
      return false;
    }
  }

  if (userHasRole(user, 'admin')) {
    return true;
  }

  const requestedPermission = typeof action === 'string' ? action.toLowerCase() : 'read';
  const userRoleIds = Array.isArray(user.roles) ? user.roles : [];
  const userIsAdmin = userRoleIds.includes('admin');

  if (userIsAdmin) {
    return true;
  }

  const permissionRows = Array.isArray(rules) ? rules : [];

  for (const roleName of userRoleIds) {
    const matchingRows = permissionRows.filter((row) => {
      const permissionName = PERMISSION_ID_TO_NAME[Number(row.permissionID)] || 'read';
      const rowRoleName = String(row.roleName || row.role || '');
      const rowResource = String(row.resourceName || resourceName || '').toLowerCase();
      const rowScope = String(row.scopeType || 'personal').toLowerCase();
      const roleMatches = rowRoleName === roleName || String(row.roleID) === String(roleName);

      return roleMatches &&
        permissionName === requestedPermission &&
        rowResource === String(resourceName).toLowerCase() &&
        rowScope === String(scopeType).toLowerCase();
    });

    if (matchingRows.some((row) => row.isAllowed === true)) {
      if (String(scopeType).toLowerCase() === 'personal') {
        if (Number(ownerId) && Number(requestUserId) && Number(requestUserId) !== Number(ownerId)) {
          return false;
        }
      }
      return true;
    }
  }

  return false;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): unknown {
  const user = res.locals?.auth?.user;
  const table = String(req.body?.resourceName || req.params?.resourceName || '');
  const action = String(req.body?.action || req.method || 'read').toLowerCase();

  if (!user || !userHasRole(user, 'admin')) {
    if (typeof res.status === 'function') {
      return res.status(403).json({ error: 'Admin-only role/permission ownership management is required.' });
    }
    return false;
  }

  if (PROTECTED_MANAGEMENT_TABLES.has(table) && !['read'].includes(action)) {
    if (typeof res.status === 'function') {
      return res.status(403).json({ error: 'Admin-only access to RBAC model objects.' });
    }
    return false;
  }

  return next();
}

function requireOwnershipOrAdmin(req: Request, res: Response, next: NextFunction): unknown {
  const user = res.locals?.auth?.user;
  const ownerId = req.body?.ownerId || req.body?.recordOwnerId;
  const resourceName = String(req.body?.resourceName || '');

  if (userHasRole(user, 'admin')) {
    return next();
  }

  const resourceOwner = Number(ownerId || 0);
  const currentUser = Number(user?.userID);

  if (resourceName && resourceOwner && currentUser !== resourceOwner) {
    if (typeof res.status === 'function') {
      return res.status(403).json({ error: 'Ownership required for personal scope access.' });
    }
    return false;
  }

  return next();
}

export {
  authorize,
  requireAdmin,
  requireOwnershipOrAdmin,
  userHasRole,
  canReadUser,
  PERMISSION_ID_TO_NAME,
  PROTECTED_MANAGEMENT_TABLES,
  ROLE_BASED_DATA_PROTECTION,
};
