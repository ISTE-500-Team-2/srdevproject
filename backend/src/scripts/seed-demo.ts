import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool, transaction } from '../db.js';
import { hashPassword } from '../passwords.js';

export async function assertDemoDatabase(pool: Pool) {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT current_database() AS name',
  );
  if (
    process.env.NODE_ENV === 'production' ||
    !/_mvc_(dev|test)$/.test(rows[0]!.name)
  ) {
    throw new Error(
      'Demo setup is limited to a dedicated database ending _mvc_dev or _mvc_test, outside production.',
    );
  }
}

export async function seedDemo(pool: Pool) {
  await assertDemoDatabase(pool);
  // Demo identities cannot be used with a published example password. The
  // explicitly enabled development-only shortcut creates a normal DB session.
  const password = await hashPassword(randomBytes(32).toString('base64url'));
  await transaction(pool, async (db) => {
    await db.query(`INSERT INTO role (roleid,role,description) VALUES
      (1,'admin','Administrator'),(2,'member','Member'),(3,'student','Student'),(4,'staff','Staff') ON CONFLICT (roleid) DO NOTHING`);
    await db.query(`INSERT INTO membership_tiers (tierid,tiername,tierprice,allottedmonths)
      VALUES (1,'Demo membership',0,1) ON CONFLICT (tierid) DO NOTHING`);
    for (const role of ['member', 'admin']) {
      const email = `demo.${role}@collaboratory.invalid`;
      await db.query(
        `INSERT INTO "user" (firstname,lastname,email,password,phone,status,statusdesc,registration_date)
        VALUES ($1,'Demo',$2,$3,'0000000000','active','Isolated development fixture',NOW() AT TIME ZONE 'UTC')
        ON CONFLICT (email) DO NOTHING`,
        [role === 'admin' ? 'Alex' : 'Jordan', email, password],
      );
      const { rows } = await db.query<{ id: number }>(
        'SELECT userid AS id FROM "user" WHERE email=$1',
        [email],
      );
      const id = rows[0]!.id;
      await db.query(
        `INSERT INTO user_role (userid,roleid,assignedat)
        SELECT $1,$2,NOW() AT TIME ZONE 'UTC' WHERE NOT EXISTS (SELECT 1 FROM user_role WHERE userid=$1 AND roleid=$2)`,
        [id, role === 'admin' ? 1 : 2],
      );
      await db.query(
        `INSERT INTO user_membership (userid,tierid,startdate,end_date,status,statusdesc)
        SELECT $1,1,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active','Development fixture'
        WHERE NOT EXISTS (SELECT 1 FROM user_membership WHERE userid=$1 AND status='active' AND end_date>NOW() AT TIME ZONE 'UTC')`,
        [id],
      );
    }
    const entries = [
      ['3D Printer', '3D printing', '/assets/3d-printer.webp', 7, false],
      ['CNC Machine', 'CNC machining', '/assets/cnc-machine.webp', 28, true],
    ];
    for (const [name, category, image, rate, waiver] of entries) {
      await db.query(
        `INSERT INTO equipment (name,category,imagepath,hourlyrate,status,waiverrequired,location)
        SELECT $1::varchar,$2::varchar,$3::varchar,$4::numeric,'available',$5::boolean,'Demo makerspace' WHERE NOT EXISTS (SELECT 1 FROM equipment WHERE name=$1)`,
        [name, category, image, rate, waiver],
      );
    }
    await db.query(
      `INSERT INTO waiver (name,version,description,effectivedate)
      SELECT 'Demo makerspace policy','DEMO-1',$1,NOW() AT TIME ZONE 'UTC'
      WHERE NOT EXISTS (SELECT 1 FROM waiver WHERE name='Demo makerspace policy')`,
      ["Training fixture only. This is not the sponsor's legal waiver."],
    );
  });
  console.log(
    'Isolated sample accounts and equipment are ready; existing records were preserved.',
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const pool = createPool();
  try {
    await seedDemo(pool);
  } finally {
    await pool.end();
  }
}
