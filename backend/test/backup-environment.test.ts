import assert from "node:assert/strict";
import { test } from "node:test";
import { backupEnvironment } from "../src/scripts/backup-environment.js";

function configured(values: Record<string, string>, work: () => void) {
  const keys = Object.keys(process.env).filter(k => k.startsWith("PG") || k === "DATABASE_URL");
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]!]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try { work(); } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("PG") || k === "DATABASE_URL") delete process.env[k];
    Object.assign(process.env, saved);
  }
}
test("backup resolves encoded URI credentials and overrides conflicting libpq defaults", () => {
  configured({ DATABASE_URL: "postgresql://fixture:fake%40pass@db:5439/arbor", PGHOST: "wrong", PGDATABASE: "wrong" }, () => {
    const env = Object.fromEntries(backupEnvironment().trimEnd().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(env.PGHOST, "db"); assert.equal(env.PGPORT, "5439");
    assert.equal(env.PGDATABASE, "arbor"); assert.equal(env.PGPASSWORD, "fake@pass");
    assert.equal(env.PGSSLMODE, "disable");
  });
});
test("backup without DATABASE_URL leaves existing PG configuration intact", () => {
  configured({ PGHOST: "db", PGDATABASE: "arbor" }, () => assert.equal(backupEnvironment(), ""));
});
test("backup retains certificate verification for TLS URLs", () => {
  configured({ DATABASE_URL: "postgresql://fixture@db/arbor?sslmode=verify-full" }, () => {
    assert.match(backupEnvironment(), /PGSSLMODE=verify-full\n/);
  });
});
test("backup rejects values that could inject another env-file entry", () => {
  configured({ DATABASE_URL: "postgresql://fixture:fake%0APGHOST%3Devil@db/arbor" }, () => {
    assert.throws(backupEnvironment, /line breaks/);
  });
});
