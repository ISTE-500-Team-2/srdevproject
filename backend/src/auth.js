/**
 * Lightweight backend RBAC helper for the Collaboratory DDL schema.
 */

const PERMISSION_ID_TO_NAME = {
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

function userHasRole(user, wantedRole) {
  if (!user || !user.roles) {
    return false;
  }
  return user.roles.some((role) => String(role) === String(wantedRole));
}

// Checks if user can read another user's data
function canReadUser(user, targetUserId) {
  // Placeholder: needs business layer
  return false;
}

/**
 * Validate a request using a role_permission-compatible rule array.
 * @param {object} options
 * @param {object} options.user - request user object, expected fields userID, roles
 * @param {Array} options.rules - DB rule rows from role_permission table
 * @param {string} options.resourceName - resource or table under test
 * @param {string} options.action - create/read/update/delete
 * @param {string} [options.scopeType='personal'] - global or personal
 * @param {number|string|null} [options.ownerId=null] - record owner userID
 * @param {number|string|null} [options.requestUserId=null] - authenticated caller userID
 * @returns {boolean}
 */
function authorize({ user, rules = [], resourceName, action = 'read', scopeType = 'personal', ownerId = null, requestUserId = null }) {
  if (!user) {
    return false;
  }
  // blocks non-admin users
  if (PROTECTED_MANAGEMENT_TABLES.has(resourceName) && !['read'].includes(action)) {
    if (!userHasRole(user, 'admin')) {
      return false;
    }
  }
  // A user may be an admin and should still be allowed to manage the access model
  if (userHasRole(user, 'admin')) {
    return true;
  }
  const requestedPermission = typeof action === 'string' ? action.toLowerCase() : 'read';
  const userRoleIds = user.roles || [];
  const userIsAdmin = userRoleIds.includes('admin');
  if (userIsAdmin) {
    return true;
  }
  const permissionRows = Array.isArray(rules) ? rules : [];

  // Matches the role rules
  for (const roleName of userRoleIds) {
    const matchingRows = permissionRows.filter((row) => {
      const permissionName = PERMISSION_ID_TO_NAME[row.permissionID] || 'read';
      const rowRoleName = String(row.roleName || row.role || '');
      const rowResource = String(row.resourceName || resourceName || '').toLowerCase();
      const rowScope = String(row.scopeType || 'personal').toLowerCase();

      // Accept either roleName or roleID shape in a DB-backed adapter
      const roleMatches = rowRoleName === roleName || String(row.roleID) === String(roleName);
      return roleMatches && permissionName === requestedPermission && rowResource === String(resourceName).toLowerCase() && rowScope === String(scopeType).toLowerCase();
    });
    if (matchingRows.some((row) => row.isAllowed === true)) {
      // If this is a personal scope permission, require record ownership
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

/**
 * Prevents staff members from altering the RBAC model unless they are an admin.
 */
function requireAdmin(req, res, next) {
  const user = req && req.user;
  const table = String(req && req.body && req.body.resourceName || req && req.params && req.params.resourceName || '');
  const action = String(req && req.body && req.body.action || req && req.method || 'read').toLowerCase();

  if (!user || !userHasRole(user, 'admin')) {
    return res && typeof res.status === 'function'
      ? res.status(403).json({ error: 'Admin-only role/permission ownership management is required.' })
      : false;
  }

  // Only admin can alter RBAC model objects
  if (PROTECTED_MANAGEMENT_TABLES.has(table) && !['read'].includes(action)) {
    return res && typeof res.status === 'function'
      ? res.status(403).json({ error: 'Admin-only access to RBAC model objects.' })
      : false;
  }
  return next();
}

/**
 * Express-style middleware for enforcing ownership in personal scope
 */
function requireOwnershipOrAdmin(req, res, next) {
  const user = req && req.user;
  const ownerId = req && req.body && req.body.ownerId;
  const recordOwnerId = req && req.body && req.body.recordOwnerId;
  const resourceName = String(req && req.body && req.body.resourceName || '');

  if (userHasRole(user, 'admin')) {
    return next();
  }

  const resourceOwner = Number(ownerId || recordOwnerId || 0);
  const currentUser = Number(user && user.userID);

  if (resourceName && resourceOwner && currentUser !== resourceOwner) {
    return res && typeof res.status === 'function'
      ? res.status(403).json({ error: 'Ownership required for personal scope access.' })
      : false;
  }
  return next();
}

module.exports = {
  authorize,
  requireAdmin,
  requireOwnershipOrAdmin,
  userHasRole,
  canReadUser,
  PERMISSION_ID_TO_NAME,
  PROTECTED_MANAGEMENT_TABLES,
};
