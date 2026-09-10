import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { migrate } from "../../src/scripts/migrate.js";

const database =
  "arbor_primary_" + randomBytes(6).toString("hex") + "_mvc_test";
const adminPool = new Pool({ connectionTimeoutMillis: 5000 }),
  pool = new Pool({ database, connectionTimeoutMillis: 5000 });
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let created = false;
const config = {
  jwtKey: randomBytes(32),
  port: 8080,
  host: "127.0.0.1",
  secureCookies: false,
  demoLogin: true,
  allowedOrigins: ["http://localhost:8080"],
  timeZone: "America/New_York",
};
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error("Explicit isolated PostgreSQL configuration required.");
  await adminPool.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
});
after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  if (created) await adminPool.query(`DROP DATABASE "${database}"`);
  await adminPool.end();
});
function client() {
  const agent = request.agent(server);
  let csrf = "",
    id = 0;
  const accept = (r: request.Response) => {
    csrf = r.body.data.csrfToken;
    id = r.body.data.user.id;
  };
  return {
    agent,
    get id() {
      return id;
    },
    async admin() {
      const r = await agent.post("/api/auth/demo").send({ role: "admin" });
      assert.equal(r.status, 200);
      accept(r);
    },
    async register() {
      const r = await agent.post("/api/auth/register").send({
        firstName: "Primary",
        lastName: "Test",
        phone: "0000000000",
        email: randomUUID() + "@example.invalid",
        password: randomBytes(24).toString("hex"),
      });
      assert.equal(r.status, 201);
      accept(r);
    },
    get: (path: string) => agent.get("/api" + path),
    post: (path: string, body: unknown = {}) =>
      agent
        .post("/api" + path)
        .set("X-CSRF-Token", csrf)
        .send(body),
    patch: (path: string, body: unknown) =>
      agent
        .patch("/api" + path)
        .set("X-CSRF-Token", csrf)
        .send(body),
  };
}
type Client = ReturnType<typeof client>;
const planBody = (kind = "membership") => ({
  name: "Plan " + randomUUID().slice(0, 8),
  kind,
  price: "125.50",
  months: kind === "membership" ? 1 : null,
  benefits: "Shop access and orientation",
  active: true,
  reason: "Integration test plan",
});
async function plan(admin: Client, kind = "membership") {
  const r = await admin.post("/admin/plans", planBody(kind));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
function issueBody(
  planId: number,
  startsAt = new Date(Date.now() - 60000).toISOString(),
) {
  return {
    requestId: randomUUID(),
    planId,
    startsAt,
    paymentStatus: "pending",
    method: "unspecified",
    reference: "",
    reason: "Integration test issuance",
  };
}
async function person(admin: Client, id: number) {
  const r = await admin.get(`/admin/users/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}
async function signPolicies(user: Client) {
  const r = await user.get("/me/waivers");
  assert.equal(r.status, 200);
  for (const w of r.body.data)
    assert.equal(
      (await user.post(`/me/waivers/${w.id}/sign`, { accepted: true })).status,
      200,
    );
}
async function issue(admin: Client, user: Client, planId: number) {
  const r = await admin.post(
    `/admin/users/${user.id}/entitlements`,
    issueBody(planId),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test("primary authorization: member isolation, staff restrictions, role changes and stale/self-change rejection", async () => {
  const admin = client(),
    member = client(),
    staff = client();
  await admin.admin();
  await member.register();
  await staff.register();
  assert.equal((await request(server).get("/api/admin/users")).status, 401);
  assert.equal((await member.get("/admin/users")).status, 403);
  assert.equal((await member.post("/admin/plans", planBody())).status, 403);
  assert.equal(
    (await admin.agent.post("/api/admin/plans").send(planBody())).status,
    403,
  );
  let target = (await person(admin, staff.id)).user;
  assert.equal(
    (
      await admin.post(`/admin/users/${staff.id}/role`, {
        role: "staff",
        revision: target.revision,
        reason: "Delegated test operator",
      })
    ).status,
    200,
  );
  assert.equal((await staff.get("/admin/users")).status, 200);
  assert.equal(
    (
      await staff.post(`/admin/users/${member.id}/role`, {
        role: "admin",
        revision: 1,
        reason: "Must be denied",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await staff.post(`/admin/users/${admin.id}/access`, {
        status: "suspended",
        revision: 1,
        reason: "Must be denied",
      })
    ).status,
    403,
  );
  target = (await person(admin, admin.id)).user;
  assert.equal(
    (
      await admin.post(`/admin/users/${admin.id}/role`, {
        role: "member",
        revision: target.revision,
        reason: "Self demotion denied",
      })
    ).status,
    409,
  );
  target = (await person(admin, member.id)).user;
  const edit = {
    firstName: "Updated",
    lastName: "Member",
    phone: "1111111111",
    reason: "Corrected contact details",
    revision: target.revision,
  };
  assert.equal(
    (await staff.patch(`/admin/users/${member.id}/profile`, edit)).status,
    200,
  );
  assert.equal(
    (await staff.patch(`/admin/users/${member.id}/profile`, edit)).status,
    409,
  );
  assert.equal(
    (await member.get("/auth/session")).body.data.user.firstName,
    "Updated",
  );
  target = (await person(admin, staff.id)).user;
  assert.equal(
    (
      await admin.post(`/admin/users/${staff.id}/role`, {
        role: "member",
        revision: target.revision,
        reason: "Remove delegated role",
      })
    ).status,
    200,
  );
  assert.equal(
    (await staff.get("/admin/users")).status,
    403,
    "existing session must immediately lose staff access",
  );
});

test("plans validate decimal amounts, preserve revisions, and reject archived issuance", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  for (const price of ["-1.00", "2.005", 3.5, "1e2"])
    assert.equal(
      (await admin.post("/admin/plans", { ...planBody(), price })).status,
      400,
    );
  const p = await plan(admin);
  const edit = {
    ...p,
    name: "Archived " + p.name,
    active: false,
    reason: "Archive old offering",
  };
  assert.equal((await admin.patch(`/admin/plans/${p.id}`, edit)).status, 200);
  assert.equal((await admin.patch(`/admin/plans/${p.id}`, edit)).status, 409);
  assert.equal(
    (await admin.post(`/admin/users/${user.id}/entitlements`, issueBody(p.id)))
      .status,
    409,
  );
  assert.equal(
    (await user.get("/plans")).body.data.some(
      (x: { id: number }) => x.id === p.id,
    ),
    false,
  );
});

test("membership issuance is atomic/idempotent, stores immutable plan details, and supports adjacent renewal", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin);
  const body = issueBody(p.id);
  const results = await Promise.all([
    admin.post(`/admin/users/${user.id}/entitlements`, body),
    admin.post(`/admin/users/${user.id}/entitlements`, body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const result = results[0]!.body.data;
  assert.equal(results[1]!.body.data.id, result.id);
  assert.equal(
    (
      await admin.post(`/admin/users/${user.id}/entitlements`, {
        ...body,
        reason: "Different request details",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await admin.post(`/admin/users/${user.id}/entitlements`, {
        ...body,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  const saved = (await user.get("/me/memberships")).body.data.memberships[0];
  const records = (await user.get("/me/payments")).body.data.items;
  assert.equal(records.length, 1);
  assert.equal(records[0].amount, "125.50");
  assert.equal(records[0].status, "pending");
  assert.equal(
    (
      await admin.patch(`/admin/plans/${p.id}`, {
        ...p,
        name: "Repriced plan",
        price: "200.00",
        benefits: "New benefits",
        reason: "New pricing for future members",
      })
    ).status,
    200,
  );
  const retained = (await user.get("/me/memberships")).body.data.memberships[0];
  assert.equal(retained.plan.price, "125.50");
  assert.equal(retained.plan.name, p.name);
  assert.equal(
    (
      await admin.post(
        `/admin/users/${user.id}/entitlements`,
        issueBody(p.id, saved.endsAt),
      )
    ).status,
    201,
  );
  assert.equal(
    (await user.get("/me/memberships")).body.data.memberships.length,
    2,
  );
  assert.equal(
    (await user.post("/me/check-ins", { location: "Test portal" })).status,
    403,
    "waivers still required",
  );
  await signPolicies(user);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Test portal" })).status,
    201,
  );
  const detail = await person(admin, user.id);
  assert.ok(
    detail.audit.items.some(
      (a: { action: string }) => a.action === "access.issued",
    ),
  );
  assert.equal(JSON.stringify(detail.audit).includes("password"), false);
});

test("facility suspension and revocation block real check-ins/bookings without erasing sessions or history", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin);
  await issue(admin, user, p.id);
  await signPolicies(user);
  const equipment = (await user.get("/equipment")).body.data.find(
    (e: { name: string }) => e.name === "3D Printer",
  );
  const start = new Date(Date.now() + 86400000),
    booking = {
      equipmentId: equipment.id,
      startTime: start.toISOString(),
      endTime: new Date(+start + 3600000).toISOString(),
    };
  assert.equal((await user.post("/reservations", booking)).status, 201);
  for (const status of ["suspended", "revoked"]) {
    const u = (await person(admin, user.id)).user;
    assert.equal(
      (
        await admin.post(`/admin/users/${user.id}/access`, {
          status,
          revision: u.revision,
          reason: "Facility access test",
        })
      ).status,
      200,
    );
    assert.equal((await user.get("/auth/session")).status, 200);
    assert.equal((await user.get("/me/overview")).body.data.canCheckIn, false);
    assert.equal(
      (await user.post("/me/check-ins", { location: "Test portal" })).status,
      403,
    );
    const rejected = await user.post("/reservations", booking);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "ACCESS_BLOCKED");
    assert.equal((await user.get("/reservations")).body.data.length, 1);
  }
  const u = (await person(admin, user.id)).user;
  assert.equal(
    (
      await admin.post(`/admin/users/${user.id}/access`, {
        status: "active",
        revision: u.revision,
        reason: "Restore facility access",
      })
    ).status,
    200,
  );
  assert.equal(
    (await user.post("/me/check-ins", { location: "Test portal" })).status,
    201,
  );
});

test("day passes enforce local calendar dates, duplicate prevention, entitlement suspension and terminal revocation", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin, "day_pass");
  const date = (
    await pool.query(
      "SELECT to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day",
    )
  ).rows[0].day;
  const body = { ...issueBody(p.id), startsAt: null, validDate: date };
  const issued = await admin.post(`/admin/users/${user.id}/entitlements`, body);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const id = issued.body.data.id;
  assert.equal(
    (
      await admin.post(`/admin/users/${user.id}/entitlements`, {
        ...body,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  await signPolicies(user);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Test pass entry" })).status,
    201,
  );
  const route = `/admin/users/${user.id}/entitlements/day_pass/${id}/status`;
  assert.equal(
    (
      await admin.post(route, {
        status: "suspended",
        revision: 1,
        reason: "Suspend pass",
      })
    ).status,
    200,
  );
  assert.equal(
    (await user.post("/me/check-ins", { location: "Test pass entry" })).status,
    403,
  );
  assert.equal(
    (
      await admin.post(route, {
        status: "active",
        revision: 2,
        reason: "Restore pass",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await admin.post(route, {
        status: "revoked",
        revision: 3,
        reason: "Revoke pass",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await admin.post(route, {
        status: "active",
        revision: 4,
        reason: "Cannot restore revoked pass",
      })
    ).status,
    409,
  );
  assert.equal(
    (await user.get("/me/memberships")).body.data.passes[0].effectiveStatus,
    "revoked",
  );
  const stranger = client();
  await stranger.register();
  assert.equal(
    (
      await admin.post(
        `/admin/users/${stranger.id}/entitlements/day_pass/${id}/status`,
        { status: "active", revision: 4, reason: "Wrong owner" },
      )
    ).status,
    404,
  );
});

test("payment records are owner-scoped, transition-controlled, audited, and do not execute refunds or revoke access", async () => {
  const admin = client(),
    user = client(),
    other = client();
  await admin.admin();
  await user.register();
  await other.register();
  const p = await plan(admin);
  const issued = await issue(admin, user, p.id);
  const route = `/admin/payments/${issued.paymentId}/status`;
  const payment = {
    status: "paid",
    method: "cash",
    reference: "TEST-RECEIPT",
    revision: 1,
    reason: "Cash recorded outside app",
  };
  assert.equal((await user.post(route, payment)).status, 403);
  assert.equal(
    (await admin.post(route, { ...payment, method: "unspecified" })).status,
    400,
  );
  assert.equal((await admin.post(route, payment)).status, 200);
  assert.equal((await admin.post(route, payment)).status, 409);
  assert.equal(
    (
      await admin.post(route, {
        ...payment,
        status: "refunded",
        revision: 2,
        reason: "External refund recorded",
      })
    ).status,
    200,
  );
  assert.equal(
    (await admin.post(route, { ...payment, revision: 3 })).status,
    409,
  );
  assert.equal(
    (await other.get(`/me/payments?userId=${user.id}`)).body.data.items.length,
    0,
  );
  assert.equal(
    (await user.get("/me/payments")).body.data.items[0].status,
    "refunded",
  );
  assert.equal(
    (await user.get("/me/overview")).body.data.entitlement.membership,
    true,
    "refund bookkeeping does not silently revoke access",
  );
  const audit = (await person(admin, user.id)).audit.items;
  const changed = audit.find(
    (a: { action: string }) => a.action === "payment.refunded",
  );
  assert.equal(changed.before.status, "paid");
  assert.equal(changed.after.status, "refunded");
  assert.equal(changed.actorId, admin.id);
});

test("new full-length policy versions require fresh agreement; old signatures remain and only admins publish", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin);
  await issue(admin, user, p.id);
  await signPolicies(user);
  const body = {
    name: "Full policy test",
    version: "v1",
    description: "Example test policy text. ".repeat(30),
    effectiveAt: new Date(Date.now() - 1000).toISOString(),
    approvalReference: "TEST FIXTURE — not sponsor approved",
    reason: "Exercise policy versioning",
  };
  assert.equal((await user.post("/admin/policies", body)).status, 403);
  const first = await admin.post("/admin/policies", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok(first.body.data.description.length > 255);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Policy check" })).status,
    403,
  );
  await signPolicies(user);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Policy check" })).status,
    201,
  );
  const next = await admin.post("/admin/policies", {
    ...body,
    version: "v2",
    effectiveAt: new Date().toISOString(),
  });
  assert.equal(next.status, 201);
  const required = (await user.get("/me/waivers")).body.data.find(
    (w: { name: string }) => w.name === body.name,
  );
  assert.equal(required.id, next.body.data.id);
  assert.equal(required.signed, false);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Policy check" })).status,
    403,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM user_waiver WHERE userid=$1 AND waiverid=$2",
        [user.id, first.body.data.id],
      )
    ).rows[0].n,
    1,
  );
  await signPolicies(user);
  assert.equal(
    (await user.post("/me/check-ins", { location: "Policy check" })).status,
    201,
  );
  assert.equal(
    (await admin.post("/admin/policies", { ...body, version: "v2" })).status,
    409,
  );
});

test("calendar-month boundaries, automatic expiry and setup reruns preserve staff revocations and audit/payment history", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin);
  const issued = await admin.post(
    `/admin/users/${user.id}/entitlements`,
    issueBody(p.id, "2096-01-31T12:00:00.000Z"),
  );
  assert.equal(issued.status, 201);
  const m = (await user.get("/me/memberships")).body.data.memberships[0];
  assert.equal(m.endsAt, "2096-02-29T12:00:00.000Z");
  assert.equal(m.effectiveStatus, "scheduled");
  await pool.query(
    "UPDATE user_membership SET startdate=(NOW()-INTERVAL '2 months') AT TIME ZONE 'UTC',end_date=(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC' WHERE membershipid=$1",
    [m.id],
  );
  assert.equal(
    (await user.get("/me/memberships")).body.data.memberships[0]
      .effectiveStatus,
    "expired",
  );
  assert.equal(
    (await user.get("/me/overview")).body.data.entitlement.membership,
    false,
  );
  const demo = (
    await pool.query('SELECT userid AS id FROM "user" WHERE email=$1', [
      "demo.member@collaboratory.invalid",
    ])
  ).rows[0].id;
  await pool.query(
    "UPDATE user_membership SET status='revoked' WHERE userid=$1",
    [demo],
  );
  const before = (
    await pool.query(
      "SELECT (SELECT COUNT(*) FROM payment) AS payments,(SELECT COUNT(*) FROM app_staff_audit) AS audit",
    )
  ).rows[0];
  await initializeDemo(pool);
  await migrate(pool);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT (SELECT COUNT(*) FROM payment) AS payments,(SELECT COUNT(*) FROM app_staff_audit) AS audit",
      )
    ).rows[0],
    before,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM user_membership WHERE userid=$1 AND status='active'",
        [demo],
      )
    ).rows[0].n,
    0,
  );
});

test("waived/void payment records and legacy-invalid plans cannot create incorrect charges or repeated issuance", async () => {
  const admin = client(),
    user = client();
  await admin.admin();
  await user.register();
  const p = await plan(admin);
  const body = {
    ...issueBody(p.id),
    paymentStatus: "waived",
    reason: "Complimentary test membership",
  };
  const issued = await admin.post(`/admin/users/${user.id}/entitlements`, body);
  assert.equal(issued.status, 201);
  const paid = (await user.get("/me/payments")).body.data.items[0];
  assert.equal(paid.amount, "0.00");
  assert.equal(paid.status, "waived");
  assert.equal(
    (await user.get("/me/memberships")).body.data.memberships[0].plan.price,
    "125.50",
  );
  const other = client();
  await other.register();
  const next = await issue(admin, other, p.id);
  const route = `/admin/payments/${next.paymentId}/status`;
  assert.equal(
    (
      await admin.post(route, {
        status: "void",
        method: "unspecified",
        reference: "",
        revision: 1,
        reason: "Void erroneous external record",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await admin.post(route, {
        status: "paid",
        method: "cash",
        reference: "",
        revision: 2,
        reason: "Cannot reopen void record",
      })
    ).status,
    409,
  );
  const legacy = await plan(admin);
  await pool.query("UPDATE membership_tiers SET tierprice=-1 WHERE tierid=$1", [
    legacy.id,
  ]);
  assert.equal(
    (
      await admin.post(
        `/admin/users/${other.id}/entitlements`,
        issueBody(legacy.id),
      )
    ).status,
    400,
  );
  assert.equal((await other.get("/me/payments")).body.data.items.length, 1);
});

test("bootstrap preserves removed demo administrator permissions and renamed/archived demo plans", async () => {
  const admin = client(),
    successor = client();
  await admin.admin();
  await successor.register();
  const successorRecord = (await person(admin, successor.id)).user;
  assert.equal(
    (
      await admin.post(`/admin/users/${successor.id}/role`, {
        role: "admin",
        revision: successorRecord.revision,
        reason: "Create successor test administrator",
      })
    ).status,
    200,
  );
  const prior = (await person(successor, admin.id)).user;
  assert.equal(
    (
      await successor.post(`/admin/users/${admin.id}/role`, {
        role: "member",
        revision: prior.revision,
        reason: "Remove demo administrator privilege",
      })
    ).status,
    200,
  );
  const plans = (await successor.get("/admin/plans")).body.data;
  const sample = plans.find(
    (p: { name: string }) => p.name === "Demo day pass",
  );
  assert.ok(sample);
  assert.equal(
    (
      await successor.patch(`/admin/plans/${sample.id}`, {
        ...sample,
        name: "Retired renamed demo pass",
        active: false,
        reason: "Retire sample offering",
      })
    ).status,
    200,
  );
  await initializeDemo(pool);
  assert.equal(
    (await admin.get("/auth/session")).body.data.user.role,
    "member",
  );
  assert.equal((await admin.get("/admin/users")).status, 403);
  const after = (await successor.get("/admin/plans")).body.data;
  assert.equal(
    after.some((p: { name: string }) => p.name === "Demo day pass"),
    false,
  );
  assert.equal(
    after.find((p: { id: number }) => p.id === sample.id).active,
    false,
  );
});
