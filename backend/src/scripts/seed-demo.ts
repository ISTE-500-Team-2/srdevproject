import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool, transaction } from "../db.js";
import { hashPassword } from "../passwords.js";
import { specializedEquipmentWaiver } from "../specializedEquipmentWaiver.js";

export async function assertDemoDatabase(pool: Pool) {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  if (
    process.env.NODE_ENV === "production" ||
    !/_mvc_(dev|test)$/.test(rows[0]!.name)
  ) {
    throw new Error(
      "Demo setup is limited to a dedicated database ending _mvc_dev or _mvc_test, outside production.",
    );
  }
}

export async function seedDemo(pool: Pool) {
  await assertDemoDatabase(pool);
  // Demo identities cannot be used with a published example password. The
  // explicitly enabled development-only shortcut creates a normal DB session.
  const password = await hashPassword(randomBytes(32).toString("base64url"));
  await transaction(pool, async (db) => {
    await db.query(`INSERT INTO role (roleid,role,description) VALUES
      (1,'admin','Administrator'),(2,'member','Member'),(3,'student','Student'),(4,'staff','Staff') ON CONFLICT (roleid) DO NOTHING`);
    await db.query(`INSERT INTO membership_tiers (tierid,tiername,tierprice,allottedmonths)
      VALUES (1,'Monthly',95.00,1) ON CONFLICT (tierid) DO NOTHING`);
    await db.query(
      `SELECT setval('app_membership_tiers_id_seq',GREATEST((SELECT COALESCE(MAX(tierid),1) FROM membership_tiers),(SELECT last_value FROM app_membership_tiers_id_seq)),true)`,
    );
    const existingDemo = await db.query(
      `SELECT userid FROM "user" WHERE email IN ('demo.member@collaboratory.invalid','demo.admin@collaboratory.invalid') LIMIT 1`,
    );
    if (!existingDemo.rows.length)
      await db.query(`INSERT INTO membership_tiers(tiername,tierprice,allottedmonths,kind,benefits)
      SELECT 'Day pass',25.00,NULL,'day_pass','One calendar day of makerspace access; waivers still required.'
      WHERE NOT EXISTS(SELECT 1 FROM membership_tiers WHERE kind='day_pass' AND active)`);
    for (const role of ["member", "admin"]) {
      const email = `demo.${role}@collaboratory.invalid`;
      const inserted = await db.query(
        `INSERT INTO "user" (firstname,lastname,email,password,phone,status,statusdesc,registration_date)
        VALUES ($1,'Demo',$2,$3,'0000000000','active','Isolated development fixture',NOW() AT TIME ZONE 'UTC')
        ON CONFLICT (email) DO NOTHING`,
        [role === "admin" ? "Alex" : "Jordan", email, password],
      );
      // Bootstrap only new identities. A later staff decision must survive
      // restarts, including removal of a demo account's administrator role.
      if (!inserted.rowCount) continue;
      const { rows } = await db.query<{ id: number }>(
        'SELECT userid AS id FROM "user" WHERE email=$1',
        [email],
      );
      const id = rows[0]!.id;
      await db.query('UPDATE "user" SET primary_role=$2 WHERE userid=$1',[id,role]);
      await db.query(
        `INSERT INTO user_role (userid,roleid,assignedat)
        SELECT $1,$2,NOW() AT TIME ZONE 'UTC' WHERE NOT EXISTS (SELECT 1 FROM user_role WHERE userid=$1 AND roleid=$2)`,
        [id, role === "admin" ? 1 : 2],
      );
      await db.query(
        `INSERT INTO user_membership (userid,tierid,startdate,end_date,status,statusdesc)
        SELECT $1,1,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active','Development fixture'
        WHERE NOT EXISTS (SELECT 1 FROM user_membership WHERE userid=$1)`,
        [id],
      );
    }
    // Matches the named machines from migration 024.
    const entries = [
      ["Rachel", "3D printer", "/assets/3d-printer.webp", 7, false],
      ["Phoebe", "3D printer", "/assets/3d-printer.webp", 7, false],
      ["Monica", "3D printer", "/assets/3d-printer.webp", 7, false],
      ["Darth Vader", "Laser engraver", "/assets/laser-engraver.webp", 20, false],
      ["Kirk", "Metal lathe", "/assets/wood-lathe.webp", 20, true],
      ["Spock", "Wood lathe", "/assets/wood-lathe.webp", 12, true],
      ["Joey", "Large CNC", "/assets/cnc-machine.webp", 28, true],
      ["Ross", "Small CNC", "/assets/cnc-machine.webp", 28, true],
      ["Chandler", "Small CNC", "/assets/cnc-machine.webp", 28, true],
    ];
    for (const [name, category, image, rate, waiver] of entries) {
      await db.query(
        `INSERT INTO equipment (name,category,imagepath,hourlyrate,status,waiverrequired,location)
        SELECT $1::varchar,$2::varchar,$3::varchar,$4::numeric,'available',$5::boolean,'Demo makerspace' WHERE NOT EXISTS (SELECT 1 FROM equipment WHERE name=$1)`,
        [name, category, image, rate, waiver],
      );
    }
    const rooms = [
      ["Project Room A", "North hallway", 6],
      ["Training Room", "Main floor", 18],
    ];
    for (const [name, location, capacity] of rooms) {
      await db.query(
        `INSERT INTO room (name,location,capacity,status)
        SELECT $1::varchar,$2::varchar,$3::integer,'available' WHERE NOT EXISTS (SELECT 1 FROM room WHERE name=$1)`,
        [name, location, capacity],
      );
    }
    await db.query(
      `INSERT INTO waiver (name,version,description,effectivedate)
      SELECT 'Demo makerspace policy','DEMO-1',$1,NOW() AT TIME ZONE 'UTC'
      WHERE NOT EXISTS (SELECT 1 FROM waiver WHERE name='Demo makerspace policy')`,
      ["Training fixture only. This is not the sponsor's legal waiver."],
    );
    // Demo and test databases show the fillable equipment waiver; production
    // publishes it from the staff workspace when the shop is ready.
    await db.query(
      `INSERT INTO waiver (name,version,description,effectivedate,isactive,required,approval_reference)
      SELECT $1::varchar,$2::varchar,$3,TIMESTAMP '2026-10-27 00:00:00',true,true,$4
      WHERE NOT EXISTS (SELECT 1 FROM waiver WHERE name=$1)`,
      [specializedEquipmentWaiver.name, specializedEquipmentWaiver.version, specializedEquipmentWaiver.text, specializedEquipmentWaiver.approvalReference],
    );
  });
  console.log(
    "Isolated sample accounts, equipment and rooms are ready; existing records were preserved.",
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
