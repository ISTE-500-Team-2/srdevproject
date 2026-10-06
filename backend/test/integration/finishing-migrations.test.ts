import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { migrate, repositoryRoot } from "../../src/scripts/migrate.js";
import { verifyMigrations } from "../../src/scripts/verify-migrations.js";
import { seedDemo } from "../../src/scripts/seed-demo.js";
test("additive finishing migrations preserve legacy training, database contents, deliberate denies and old checksums", async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  const database =
      "arbor_finishing_" + randomBytes(6).toString("hex") + "_mvc_test",
    admin = new Pool(),
    pool = new Pool({ database });
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await pool.query(
      await readFile(
        path.join(repositoryRoot, "ddl/collaboratory-db-create.sql"),
        "utf8",
      ),
    );
    await pool.query(
      "CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    const dir = path.join(repositoryRoot, "database/migrations");
    for (const name of (await readdir(dir))
      .filter((n) => /^\d+.*\.sql$/.test(n) && n < "015")
      .sort()) {
      const sql = await readFile(path.join(dir, name), "utf8");
      await pool.query(sql);
      await pool.query(
        "INSERT INTO app_migration(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    await seedDemo(pool);
    const user = (await pool.query('SELECT MIN(userid) AS id FROM "user"'))
      .rows[0].id;
    await pool.query(
      "INSERT INTO certifications(certid,name,description,effectivedate,enddate) VALUES(500,'Legacy qualification','Keep original','2020-01-01','2030-01-01')",
    );
    await pool.query(
      "INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status,statusdesc) VALUES(500,$1,500,'2029-01-01','active','Original instructor record')",
      [user],
    );
    await pool.query(
      "INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed) SELECT r.roleid,p.permissionid,'certification','global',false FROM role r JOIN permission p ON p.permissionname='create' WHERE r.role='instructor' ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO UPDATE SET isallowed=false",
    );
    const original = (await pool.query("SELECT * FROM user_certifications"))
        .rows[0],
      ledger = (
        await pool.query(
          "SELECT name,checksum FROM app_migration ORDER BY name",
        )
      ).rows;
    await assert.rejects(
      verifyMigrations(pool),
      /Reviewed migration is required/,
    );
    await migrate(pool);
    await verifyMigrations(pool);
    const updated = (await pool.query("SELECT * FROM user_certifications"))
      .rows[0];
    for (const [key, value] of Object.entries(original))
      assert.deepEqual(updated[key], value);
    assert.equal(updated.approved_by, null);
    assert.equal(updated.trained_at, null);
    assert.equal(updated.revision, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT isallowed FROM role_permission WHERE roleid=(SELECT roleid FROM role WHERE role='instructor') AND permissionid=(SELECT permissionid FROM permission WHERE permissionname='create') AND resourcename='certification' AND scopetype='global'",
        )
      ).rows[0].isallowed,
      false,
    );
    const after = (
      await pool.query("SELECT name,checksum FROM app_migration ORDER BY name")
    ).rows;
    for (const entry of ledger)
      assert.deepEqual(
        after.find((r) => r.name === entry.name),
        entry,
      );
    await migrate(pool);
    assert.deepEqual(
      (await pool.query("SELECT * FROM user_certifications")).rows[0],
      updated,
    );
    await pool.query(
      "UPDATE app_migration SET checksum=repeat('0',64) WHERE name='017_training_classes.sql'",
    );
    await assert.rejects(verifyMigrations(pool), /checksum mismatch/);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});
