import type { Database } from "../../db.js";

/** A person as staff screens see them (personColumns projection). */
export interface StaffPerson {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  // Nullable in the legacy schema; every application write sets it.
  status: string;
  accountReason: string | null;
  primaryRole: string;
  isStudent: boolean;
  accessStatus: string;
  accessReason: string;
  revision: number;
  conductFlag: boolean;
  address: Record<string, unknown>;
  contactPreferences: Record<string, unknown>;
  roles: string[];
}

const personColumns = `u.userid AS id,u.firstname AS "firstName",u.lastname AS "lastName",u.email,u.phone,u.status,u.statusdesc AS "accountReason",
  u.primary_role AS "primaryRole",u.is_student AS "isStudent",u.accessstatus AS "accessStatus",u.accessreason AS "accessReason",u.revision,
  COALESCE(u.conductflag,false) AS "conductFlag",
  u.profile_address AS address,u.contact_preferences AS "contactPreferences",
  COALESCE((SELECT json_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid),'[]') AS roles`;

/** User directory, account state and role assignments. */
export class PeopleRepository {
  constructor(private db: Database) {}
  // Unverified legacy requests stay recoverable but never appear in the member directory.
  async users(search: string, offset: number): Promise<StaffPerson[]> {
    return (
      await this.db.query<StaffPerson>(
        `SELECT ${personColumns} FROM "user" u WHERE u.email_confirmed=true AND
      (u.firstname || ' ' || u.lastname || ' ' || u.email) ILIKE $1 ORDER BY u.lastname,u.firstname,u.userid LIMIT 51 OFFSET $2`,
        ["%" + search + "%", offset],
      )
    ).rows;
  }
  async person(id: number, lock: boolean | 'no-key-update' = false): Promise<StaffPerson | undefined> {
    return (
      await this.db.query<StaffPerson>(
        `SELECT ${personColumns} FROM "user" u WHERE userid=$1 ${lock === 'no-key-update' ? 'FOR NO KEY UPDATE OF u' : lock ? 'FOR UPDATE OF u' : ''}`,
        [id],
      )
    ).rows[0];
  }
  async updatePerson(
    id: number,
    firstName: string,
    lastName: string,
    phone: string,
    revision: number,
  ): Promise<StaffPerson | undefined> {
    const result = await this.db.query(
      `UPDATE "user" SET firstname=$2,lastname=$3,phone=$4,revision=revision+1 WHERE userid=$1 AND revision=$5 RETURNING userid`,
      [id, firstName, lastName, phone, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async access(id: number, status: string, reason: string, revision: number): Promise<StaffPerson | undefined> {
    const result = await this.db.query(
      `UPDATE "user" SET accessstatus=$2,accessreason=$3,revision=revision+1 WHERE userid=$1 AND revision=$4 RETURNING userid`,
      [id, status, reason, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async conduct(id: number, flagged: boolean, revision: number): Promise<StaffPerson | undefined> {
    const result = await this.db.query(
      `UPDATE "user" SET conductflag=$2,revision=revision+1 WHERE userid=$1 AND revision=$3 RETURNING userid`,
      [id, flagged, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async accountStatus(id: number, status: string, reason: string, revision: number): Promise<StaffPerson | undefined> {
    const result = await this.db.query(
      `UPDATE "user" SET status=$2,statusdesc=$3,revision=revision+1 WHERE userid=$1 AND revision=$4 RETURNING userid`,
      [id, status, reason, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async setRole(id: number, role: string, roles?: string[], isStudent?: boolean): Promise<StaffPerson | undefined> {
    if (roles) {
      // Explicit multi-role editor replaces managed roles only; retain unknown legacy classifications.
      await this.db.query(
        `DELETE FROM user_role WHERE userid=$1 AND roleid IN
        (SELECT roleid FROM role WHERE role IN ('member','admin','staff','subscriber','day_pass','instructor','student'))`,
        [id],
      );
    }
    await this.db.query(
      `INSERT INTO user_role(userid,roleid,assignedat)
      SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role=ANY($2::text[])
      AND NOT EXISTS(SELECT 1 FROM user_role ur WHERE ur.userid=$1 AND ur.roleid=role.roleid)`,
      [id, roles ?? [role]],
    );
    await this.db.query(
      'UPDATE "user" SET primary_role=$2,is_student=COALESCE($3,is_student),revision=revision+1 WHERE userid=$1',
      [id, role, isStudent ?? null],
    );
    return this.person(id);
  }
  async roleExists(role: string): Promise<boolean> {
    return (
      (await this.db.query("SELECT roleid FROM role WHERE role=$1", [role]))
        .rows.length === 1
    );
  }
  async activeAdmins(): Promise<number> {
    return Number(
      (
        // COUNT is bigint, which node-postgres returns as a string.
        await this.db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT u.userid) AS count FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid) WHERE u.status='active' AND r.role='admin'`,
        )
      ).rows[0]!.count,
    );
  }
}
