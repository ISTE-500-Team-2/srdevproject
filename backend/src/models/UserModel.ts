// Loads current account/role data and persists profiles; credential reads are separate from public
// user projections.

import type { Database } from "../db.js";
import type { ProfileFieldPatch, ProfileFields, UserView } from "../domain.js";
import { primaryRoleSql, storedRolesSql } from "./staff/people.js";

export interface UserProfileView {
  user: Omit<UserView, "status" | "accessStatus" | "photoVersion">;
  address: ProfileFields;
  contactPreferences: ProfileFields;
  studioContact: { name: string; email: string; phone: string | null };
  /** When the member last set a password here (change or reset); null before this was recorded. */
  passwordChangedAt: Date | null;
  /** A new sign-in email waiting for its link to be opened. */
  pendingEmail: { email: string; expiresAt: string } | null;
}

export const studioContact = {
  name: "The Crafty Studio",
  email: process.env.STUDIO_CONTACT_EMAIL ?? "arborcollaboratory@yahoo.com",
  phone: process.env.STUDIO_CONTACT_PHONE?.trim() || null,
};

/**
 * Role precedence (admin > staff > member), role list and active-membership window, shared by
 * every user projection so authentication and profile responses cannot drift apart.
 */
const identityProjection = `             CASE
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'admin') THEN 'admin'
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'staff') THEN 'staff'
               ELSE 'member'
             END AS role,
             ${storedRolesSql("u")} AS roles,
             CASE WHEN EXISTS (SELECT 1 FROM user_membership um WHERE um.userid=u.userid AND um.status='active'
                               AND um.startdate <= NOW() AT TIME ZONE 'UTC' AND um.end_date > NOW() AT TIME ZONE 'UTC')
                  THEN 'Monthly' ELSE 'None' END AS membership`;

export class UserModel {
  constructor(private db: Database, private timeZone = "America/New_York") {}

  async findById(id: number): Promise<UserView | null> {
    const { rows } = await this.db.query<UserView>(
      `
      SELECT u.userid AS id, u.firstname AS "firstName", u.lastname AS "lastName", u.email,
             (u.dob IS NOT NULL AND u.dob::date>((NOW() AT TIME ZONE $2)::date-INTERVAL '18 years')::date) AS "isMinor",
             (SELECT a.firstname||' '||a.lastname FROM app_minor_sponsor s JOIN "user" a ON a.userid=s.adult_id WHERE s.minor_id=u.userid) AS "sponsorName",
             ${primaryRoleSql("u")} AS "primaryRole",u.is_student AS "isStudent",u.phone, COALESCE(u.status, '') AS status,u.accessstatus AS "accessStatus",
             (SELECT p.version FROM app_user_photo p WHERE p.user_id=u.userid) AS "photoVersion",
${identityProjection}
      FROM "user" u WHERE u.userid=$1`,
      [id, this.timeZone],
    );
    return rows[0] ?? null;
  }

  async credentials(
    email: string,
  ): Promise<{ id: number; password: string; emailConfirmed:boolean } | null> {
    const { rows } = await this.db.query<{ id: number; password: string; emailConfirmed:boolean }>(
      `SELECT userid AS id,password,email_confirmed AS "emailConfirmed" FROM "user"
       WHERE lower(email)=$1`,
      [email],
    );
    return rows[0] ?? null;
  }

  /** The hash a sign-up still waiting for inbox confirmation was made with; undefined when none is pending. */
  async pendingCredentials(email: string) {
    return (await this.db.query<{ password_hash: string }>('SELECT password_hash FROM app_pending_registration WHERE email=$1 AND expires_at>NOW()', [email])).rows[0];
  }

  /** Swaps a legacy hash for its upgrade unless the password changed meanwhile; rowCount says which. */
  async upgradePassword(id: number, upgraded: string, current: string) {
    return this.db.query('UPDATE "user" SET password=$1 WHERE userid=$2 AND password=$3',[upgraded,id,current]);
  }

  async emailConfirmation(id: number) {
    return (await this.db.query<{ email_confirmed: boolean }>('SELECT email_confirmed FROM "user" WHERE userid=$1',[id])).rows[0];
  }

  async status(id: number) {
    return (await this.db.query('SELECT status FROM "user" WHERE userid=$1',[id])).rows[0];
  }

  /** The stored hash, share-locked until the caller's transaction ends so a reset can't slip in. */
  async lockedPassword(id: number) {
    return (await this.db.query<{ password: string }>('SELECT password FROM "user" WHERE userid=$1 FOR SHARE', [id])).rows[0];
  }

  /** Locks the account row until the caller's transaction ends. */
  async lockForUpdate(id: number) {
    await this.db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [
      id,
    ]);
  }

  async create(input: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    password: string;
    dob: string;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `
      INSERT INTO "user" (firstname,lastname,email,password,phone,dob,status,statusdesc,registration_date)
      VALUES ($1,$2,$3,$4,$5,$6,'active','Registered',NOW() AT TIME ZONE 'UTC') RETURNING userid AS id`,
      [
        input.firstName,
        input.lastName,
        input.email,
        input.password,
        input.phone,
        input.dob,
      ],
    );
    const id = rows[0]!.id;
    await this.db.query(
      `INSERT INTO user_role (userid,roleid,assignedat)
                         SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role='member'`,
      [id],
    );
    return id;
  }

  async updateProfile(
    id: number,
    firstName: string,
    lastName: string,
    phone: string,
    address: ProfileFieldPatch,
    contactPreferences: ProfileFieldPatch,
  ): Promise<UserView | null> {
    await this.db.query(
      'UPDATE "user" SET firstname=$2, lastname=$3, phone=$4, profile_address=jsonb_strip_nulls(profile_address || $5::jsonb), contact_preferences=jsonb_strip_nulls(contact_preferences || $6::jsonb), revision=revision+1 WHERE userid=$1',
      [
        id,
        firstName,
        lastName,
        phone,
        JSON.stringify(address),
        JSON.stringify(contactPreferences),
      ],
    );
    return this.findById(id);
  }

  async profile(id: number): Promise<UserProfileView | null> {
    const { rows } = await this.db.query<{
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      role: UserView["role"];
      roles: string[];
      membership: UserView["membership"];
      address: ProfileFields;
      contactPreferences: ProfileFields;
      passwordChangedAt: Date | null;
      pendingEmail: { email: string; expiresAt: string } | null;
    }>(
      `
      SELECT u.userid AS id, u.firstname AS "firstName", u.lastname AS "lastName", u.email, u.phone,
${identityProjection},
             u.profile_address AS address,
             u.contact_preferences AS "contactPreferences",
             u.password_changed_at AS "passwordChangedAt",
             (SELECT json_build_object('email',c.new_email,'expiresAt',c.expires_at) FROM app_email_change c
               WHERE c.userid=u.userid AND c.expires_at>NOW()) AS "pendingEmail"
      FROM "user" u WHERE u.userid=$1`,
      [id],
    );
    const row = rows[0];
    return row
      ? {
          user: {
            id: row.id,
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            phone: row.phone,
            role: row.role,
            roles: row.roles,
            membership: row.membership,
          },
          address: row.address ?? {},
          contactPreferences: row.contactPreferences ?? {},
          studioContact,
          passwordChangedAt: row.passwordChangedAt,
          pendingEmail: row.pendingEmail,
        }
      : null;
  }
}
