import type { Database } from '../db.js';
import type { UserView } from '../domain.js';

export class UserModel {
  constructor(private db: Database) {}

  async findById(id: number): Promise<UserView | null> {
    const { rows } = await this.db.query<UserView>(
      `
      SELECT u.userid AS id, u.firstname AS "firstName", u.lastname AS "lastName", u.email,
             u.phone, COALESCE(u.status, '') AS status,
             CASE WHEN EXISTS (SELECT 1 FROM user_role ur JOIN role r USING (roleid)
                               WHERE ur.userid=u.userid AND r.role IN ('admin','staff')) THEN 'admin' ELSE 'member' END AS role,
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
  ): Promise<{ id: number; password: string } | null> {
    const { rows } = await this.db.query<{ id: number; password: string }>(
      'SELECT userid AS id, password FROM "user" WHERE lower(email)=$1',
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
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `
      INSERT INTO "user" (firstname,lastname,email,password,phone,status,statusdesc,registration_date)
      VALUES ($1,$2,$3,$4,$5,'active','Registered',NOW() AT TIME ZONE 'UTC') RETURNING userid AS id`,
      [
        input.firstName,
        input.lastName,
        input.email,
        input.password,
        input.phone,
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
  ): Promise<UserView | null> {
    await this.db.query(
      'UPDATE "user" SET firstname=$2, lastname=$3, phone=$4 WHERE userid=$1',
      [id, firstName, lastName, phone],
    );
    return this.findById(id);
  }
}
