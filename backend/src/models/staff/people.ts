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
  /** Roles staff assign by hand (staff, administrator, instructor, community member). */
  roles: string[];
  /**
   * Subscriber and day-pass customer: never stored or edited, they follow what the member holds now
   * (see automaticRolesSql).
   */
  automaticRoles: string[];
  /** Directory and record reads only: the member's photo version, null without one. */
  photoVersion?: string | null;
  /** Whether a date of birth is recorded. Accounts made before it was collected have none. */
  dobOnFile: boolean;
}

/**
 * FR-006/FR-008: the subscriber and day-pass labels describe purchases, so they are read from the
 * member's memberships and passes instead of being stored, and can't drift when one is bought,
 * cancelled, suspended or simply runs out. Subscriber: an active membership that hasn't ended
 * (running now or scheduled to start). Day-pass customer: an active pass for today or a later day.
 * A suspended entitlement grants no access, so it gives no label while on hold. These labels carry
 * no permissions: every account keeps a stored primary role (community member at least).
 */
export const automaticRolesSql = (user: string, zone: string) => `ARRAY_REMOVE(ARRAY[
  CASE WHEN EXISTS(SELECT 1 FROM user_membership am WHERE am.userid=${user} AND am.status='active'
    AND am.end_date>NOW() AT TIME ZONE 'UTC') THEN 'subscriber' END,
  CASE WHEN EXISTS(SELECT 1 FROM day_pass ad WHERE ad.userid=${user} AND ad.status='active'
    AND ad.validdate::date>=(NOW() AT TIME ZONE ${zone})::date) THEN 'day_pass' END]::text[],NULL)`;

const personColumns = (zone: string) => `u.userid AS id,u.firstname AS "firstName",u.lastname AS "lastName",u.email,u.phone,u.status,u.statusdesc AS "accountReason",
  u.primary_role AS "primaryRole",u.is_student AS "isStudent",u.accessstatus AS "accessStatus",u.accessreason AS "accessReason",u.revision,
  COALESCE(u.conductflag,false) AS "conductFlag",u.dob IS NOT NULL AS "dobOnFile",
  u.profile_address AS address,u.contact_preferences AS "contactPreferences",
  COALESCE((SELECT json_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid),'[]') AS roles,
  ${automaticRolesSql("u.userid", zone)} AS "automaticRoles"`;

/** User directory, account state and role assignments. */
export class PeopleRepository {
  constructor(
    private db: Database,
    private timeZone = "America/New_York",
  ) {}
  // Unverified legacy requests stay recoverable but never appear in the member directory.
  async users(search: string, offset: number): Promise<StaffPerson[]> {
    return (
      await this.db.query<StaffPerson>(
        `SELECT ${personColumns("$3")},(SELECT p.version FROM app_user_photo p WHERE p.user_id=u.userid) AS "photoVersion"
      FROM "user" u WHERE u.email_confirmed=true AND
      (u.firstname || ' ' || u.lastname || ' ' || u.email) ILIKE $1 ESCAPE '\\' ORDER BY u.lastname,u.firstname,u.userid LIMIT 51 OFFSET $2`,
        // Escaped so "%" and "_" (common in emails) match themselves, not any text.
        ["%" + search.replace(/[\\%_]/g, (c) => "\\" + c) + "%", offset, this.timeZone],
      )
    ).rows;
  }
  async person(id: number, lock: boolean | 'no-key-update' = false): Promise<StaffPerson | undefined> {
    return (
      await this.db.query<StaffPerson>(
        `SELECT ${personColumns("$2")} FROM "user" u WHERE userid=$1 ${lock === 'no-key-update' ? 'FOR NO KEY UPDATE OF u' : lock ? 'FOR UPDATE OF u' : ''}`,
        [id, this.timeZone],
      )
    ).rows[0];
  }
  async updatePerson(
    id: number,
    firstName: string,
    lastName: string,
    phone: string,
    revision: number,
    // Only fills a missing date of birth; one already on file is never replaced here.
    dob: string | null = null,
  ): Promise<StaffPerson | undefined> {
    const result = await this.db.query(
      `UPDATE "user" SET firstname=$2,lastname=$3,phone=$4,dob=COALESCE(dob,$6::date),revision=revision+1 WHERE userid=$1 AND revision=$5 RETURNING userid`,
      [id, firstName, lastName, phone, revision, dob],
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
