import type { Database } from "../db.js";
import type { ProfileFieldPatch, ProfileFields, UserView } from "../domain.js";

export interface UserProfileView {
  user: Omit<UserView, "status" | "accessStatus">;
  address: ProfileFields;
  contactPreferences: ProfileFields;
  studioContact: { name: string; email: string; phone: string | null };
}

export const studioContact = {
  name: "The Crafty Studio",
  email: process.env.STUDIO_CONTACT_EMAIL ?? "arborcollaboratory@yahoo.com",
  phone: process.env.STUDIO_CONTACT_PHONE?.trim() || null,
};

export class UserModel {
  constructor(private db: Database) {}

  async findById(id: number): Promise<UserView | null> {
    const { rows } = await this.db.query<UserView>(
      `
      SELECT u.userid AS id, u.firstname AS "firstName", u.lastname AS "lastName", u.email,
             u.phone, COALESCE(u.status, '') AS status,u.accessstatus AS "accessStatus",
             CASE
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'admin') THEN 'admin'
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'staff') THEN 'staff'
               ELSE 'member'
             END AS role,
             COALESCE((SELECT json_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING (roleid) WHERE ur.userid=u.userid), '[]') AS roles,
             CASE WHEN EXISTS (SELECT 1 FROM user_membership um WHERE um.userid=u.userid AND um.status='active'
                               AND um.startdate <= NOW() AT TIME ZONE 'UTC' AND um.end_date > NOW() AT TIME ZONE 'UTC')
                  THEN 'Monthly' ELSE 'None' END AS membership
      FROM "user" u WHERE u.userid=$1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async credentials(
    email: string,
  ): Promise<{ id: number; password: string; emailConfirmed:boolean } | null> {
    const { rows } = await this.db.query<{ id: number; password: string; emailConfirmed:boolean }>(
      'SELECT userid AS id, password,email_confirmed AS "emailConfirmed" FROM "user" WHERE lower(email)=$1',
      [email],
    );
    return rows[0] ?? null;
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
    }>(
      `
      SELECT u.userid AS id, u.firstname AS "firstName", u.lastname AS "lastName", u.email, u.phone,
             CASE
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'admin') THEN 'admin'
               WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                            WHERE ur.userid=u.userid AND r.role = 'staff') THEN 'staff'
               ELSE 'member'
             END AS role,
             COALESCE((SELECT json_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING (roleid) WHERE ur.userid=u.userid), '[]') AS roles,
             CASE WHEN EXISTS (SELECT 1 FROM user_membership um WHERE um.userid=u.userid AND um.status='active'
                               AND um.startdate <= NOW() AT TIME ZONE 'UTC' AND um.end_date > NOW() AT TIME ZONE 'UTC')
                  THEN 'Monthly' ELSE 'None' END AS membership,
             u.profile_address AS address,
             u.contact_preferences AS "contactPreferences"
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
        }
      : null;
  }
}
