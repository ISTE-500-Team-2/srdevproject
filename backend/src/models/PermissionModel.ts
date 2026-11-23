// Resolves role grants from the database so permission changes take effect without issuing new tokens.

import type { Database } from '../db.js';
import type { UserView } from '../domain.js';
import { authorize } from '../auth.js';
import { storedRolesSql } from './staff/people.js';
export class PermissionModel {
  constructor(private db: Database) {}
  async allows(user: UserView, resourceName: string, action: string, ownerId: number | null = null) {
    // Grants of the roles the account reads as holding (storedRolesSql): a subscriber/day-pass row
    // an older app version wrote counts for nothing, and a primary role left on one counts as
    // community member.
    const {rows} = await this.db.query(`SELECT r.role AS "roleName", p.permissionname AS "permissionName",
      rp.resourcename AS "resourceName", rp.scopetype AS "scopeType", rp.isallowed AS "isAllowed"
      FROM role r JOIN role_permission rp ON rp.roleid=r.roleid JOIN permission p ON p.permissionid=rp.permissionid
      WHERE r.role IN (SELECT json_array_elements_text(${storedRolesSql('u')}) FROM "user" u WHERE u.userid=$1)`, [user.id]);
    return authorize({user, rules: rows, resourceName, action, ownerId});
  }
}
