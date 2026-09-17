import type { Database } from '../db.js';
import type { UserView } from '../domain.js';
import { authorize } from '../auth.js';
export class PermissionModel {
  constructor(private db: Database) {}
  async allows(user: UserView, resourceName: string, action: string) {
    const {rows} = await this.db.query(`SELECT r.role AS "roleName", p.permissionname AS "permissionName",
      rp.resourcename AS "resourceName", rp.scopetype AS "scopeType", rp.isallowed AS "isAllowed"
      FROM user_role ur JOIN role r ON r.roleid=ur.roleid
      JOIN role_permission rp ON rp.roleid=r.roleid JOIN permission p ON p.permissionid=rp.permissionid
      WHERE ur.userid=$1`, [user.id]);
    return authorize({user, rules: rows, resourceName, action});
  }
}
