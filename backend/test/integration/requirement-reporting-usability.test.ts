import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { membershipTrends } from "../../src/membershipReports.js";
import { notificationMetrics } from "../../src/notifications/store.js";
const database =
  "arbor_requirements_" + randomBytes(6).toString("hex") + "_mvc_test";
const admin = new Pool(),
  pool = new Pool({ database });
const config = {
  jwtKey: randomBytes(32),
  port: 8080,
  host: "127.0.0.1",
  secureCookies: false,
  demoLogin: true,
  allowedOrigins: [],
  timeZone: "America/New_York",
};
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Explicit isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  await initializeDemo(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

test("legitimate rotations do not consume sign-in budget; refresh remains bounded and protected", async () => {
  const app = createApp(pool, config),
    browser = request.agent(app);
  let response = await browser.post("/api/auth/demo").send({ role: "member" });
  assert.equal(response.status, 200);
  let csrf = response.body.data.csrfToken;
  for (let n = 0; n < 40; n++) {
    response = await browser
      .post("/api/auth/refresh")
      .set("X-CSRF-Token", csrf)
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    csrf = response.body.data.csrfToken;
  }
  assert.equal(
    (
      await browser
        .get("/api/auth/session")
        .set("Authorization", "Bearer " + response.body.data.accessToken)
    ).status,
    200,
  );
  assert.equal(
    (await browser.post("/api/auth/demo").send({ role: "admin" })).status,
    200,
  );
  assert.equal(
    (
      await browser
        .post("/api/auth/refresh")
        .set("X-CSRF-Token", "wrong")
        .send({})
    ).status,
    401,
  );
  // Failed sign-ins still share the original 30/15min bucket, independently.
  for (let n = 0; n < 28; n++)
    assert.equal(
      (
        await browser
          .post("/api/auth/login")
          .send({ email: "missing@example.invalid", password: "BadPassword!1" })
      ).status,
      401,
    );
  const blocked = await browser
    .post("/api/auth/login")
    .send({ email: "missing@example.invalid", password: "BadPassword!1" });
  assert.equal(blocked.status, 429);
  assert(Number(blocked.headers["retry-after"]) > 0);
  const separate = createApp(pool, config);
  for (let n = 0; n < 120; n++)
    assert.equal(
      (await request(separate).post("/api/auth/refresh").send({})).status,
      401,
    );
  const throttled = await request(separate).post("/api/auth/refresh").send({});
  assert.equal(throttled.status, 429);
  assert(Number(throttled.headers["retry-after"]) <= 60);
  assert.equal(
    (await request(separate).post("/api/auth/demo").send({ role: "member" }))
      .status,
    200,
  );
});

test("training identity lookup is bounded, literal, minimally scoped and permission checked", async () => {
  const app = createApp(pool, config),
    staff = request.agent(app),
    member = request.agent(app);
  let login = await staff.post("/api/auth/demo").send({ role: "admin" });
  const token = login.body.data.accessToken;
  login = await member.post("/api/auth/demo").send({ role: "member" });
  const id = login.body.data.user.id;
  assert.equal(
    (await request(app).get("/api/training/members?search=demo")).status,
    401,
  );
  assert.equal(
    (
      await member
        .get("/api/training/members?search=demo")
        .set("Authorization", "Bearer " + login.body.data.accessToken)
    ).status,
    403,
  );
  assert.equal(
    (
      await staff
        .get("/api/training/members?search=d")
        .set("Authorization", "Bearer " + token)
    ).status,
    400,
  );
  let result = await staff
    .get("/api/training/members?search=Jordan")
    .set("Authorization", "Bearer " + token);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.items[0].id, id);
  assert.deepEqual(Object.keys(result.body.data.items[0]).sort(), [
    "email",
    "id",
    "name",
  ]);
  assert.equal(
    (
      await staff
        .get("/api/training/members?search=%25%25")
        .set("Authorization", "Bearer " + token)
    ).body.data.items.length,
    0,
  );
  await pool.query(
    "INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'",
    [id],
  );
  assert.equal(
    (
      await member
        .get("/api/admin/users")
        .set("Authorization", "Bearer " + login.body.data.accessToken)
    ).status,
    403,
  );
  result = await member
    .get("/api/training/members?search=demo&role=instructor")
    .set("Authorization", "Bearer " + login.body.data.accessToken);
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.items.map((p: { id: number }) => p.id),
    [id],
  );
  await pool.query(
    "UPDATE role_permission SET isallowed=false WHERE roleid=(SELECT roleid FROM role WHERE role='instructor') AND resourcename='certification' AND permissionid=(SELECT permissionid FROM permission WHERE permissionname='read')",
  );
  assert.equal(
    (
      await member
        .get("/api/training/members?search=demo")
        .set("Authorization", "Bearer " + login.body.data.accessToken)
    ).status,
    403,
  );
});

test("membership trends count people, not renewals, and separate confirmed cancellation from paid access", async () => {
  const tier = (
    await pool.query(
      "SELECT tierid FROM membership_tiers WHERE kind='membership' ORDER BY tierid LIMIT 1",
    )
  ).rows[0].tierid;
  const users: number[] = [];
  for (let n = 0; n < 3; n++)
    users.push(
      (
        await pool.query(
          `INSERT INTO "user"(firstname,lastname,email,password,phone,status) VALUES('Trend',$1,$2,'not-a-login','0000000000','active') RETURNING userid`,
          [String(n), `trend${n}@example.invalid`],
        )
      ).rows[0].userid,
    );
  const membership = async (
    id: number,
    start: string,
    end: string,
    status = "active",
  ) =>
    pool.query(
      "INSERT INTO user_membership(userid,tierid,startdate,end_date,status) VALUES($1,$2,$3,$4,$5)",
      [id, tier, start, end, status],
    );
  await membership(users[0]!, "2025-12-30 05:00", "2026-01-02 05:00");
  await membership(users[0]!, "2026-01-02 05:00", "2026-01-04 05:00");
  await membership(users[1]!, "2026-01-01 05:00", "2026-01-03 05:00");
  await membership(
    users[2]!,
    "2026-01-01 05:00",
    "2026-01-04 05:00",
    "revoked",
  );
  for (let n = 1; n < 3; n++)
    await pool.query(
      `INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,cancellation_requested_at,cancellation_confirmed) VALUES($1,$2,$3,'{}',100,'canceled','2026-01-02T12:00Z',$4)`,
      [randomUUID(), users[n], tier, n === 1],
    );
  const rows = await membershipTrends(
    pool,
    new Date("2026-01-01T05:00Z"),
    new Date("2026-01-04T05:00Z"),
    "America/New_York",
    "day",
  );
  assert.deepEqual(rows, [
    {
      period: "2026-01-01",
      newMembers: 2,
      activeMembers: 2,
      expiringMembers: 0,
      cancelledMembers: 0,
    },
    {
      period: "2026-01-02",
      newMembers: 0,
      activeMembers: 2,
      expiringMembers: 0,
      cancelledMembers: 1,
    },
    {
      period: "2026-01-03",
      newMembers: 0,
      activeMembers: 1,
      expiringMembers: 1,
      cancelledMembers: 0,
    },
  ]);
  for (const bucket of ["week", "month"] as const) {
    const grouped = await membershipTrends(
      pool,
      new Date("2026-01-01T05:00Z"),
      new Date("2026-01-04T05:00Z"),
      "America/New_York",
      bucket,
    );
    assert.equal(grouped.length, 1);
    assert.deepEqual(
      { ...grouped[0], period: "" },
      {
        period: "",
        newMembers: 2,
        activeMembers: 2,
        expiringMembers: 1,
        cancelledMembers: 1,
      },
    );
  }
  const billing = (
    await pool.query("SELECT id FROM app_membership_billing WHERE userid=$1", [
      users[1],
    ])
  ).rows[0].id;
  await pool.query(
    `INSERT INTO app_notification_outbox(userid,kind,dedupe_key,status,counts_for_sla,deadline_at) VALUES($1,'membership_cancelled',$2,'suppressed',false,NOW())`,
    [users[1], "membership-cancel:" + billing],
  );
  // A later terminal provider status can clear the current confirmation flag;
  // the original acknowledged request must remain in the historical trend.
  await pool.query(
    "UPDATE app_membership_billing SET cancellation_confirmed=false WHERE id=$1",
    [billing],
  );
  assert.equal(
    (
      await membershipTrends(
        pool,
        new Date("2026-01-01T05:00Z"),
        new Date("2026-01-04T05:00Z"),
        "America/New_York",
        "day",
      )
    )[1]!.cancelledMembers,
    1,
  );
  const app = createApp(pool, config),
    login = await request(app).post("/api/auth/demo").send({ role: "admin" });
  for (const format of ["", "&format=csv", "&format=pdf"]) {
    const result = await request(app)
      .get(
        "/api/admin/reports" +
          (format ? "/export" : "") +
          "?from=2026-01-01&to=2026-01-03&period=daily" +
          format,
      )
      .set("Authorization", "Bearer " + login.body.data.accessToken);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (!format) assert.deepEqual(result.body.data.memberships, rows);
    else if (format.endsWith("csv")) {
      assert.match(result.body.data.content, /memberships/);
      assert.match(result.body.data.content, /expirationCompliance/);
    } else {
      const pdf = Buffer.from(result.body.data.content, "base64").toString();
      assert.match(pdf, /memberships/);
      assert.match(pdf, /notifications/);
    }
  }
});

test("BR009 cohort excludes account and membership notices; callbacks cannot inflate counts", async () => {
  const user = (
    await pool.query('SELECT userid FROM "user" ORDER BY userid LIMIT 1')
  ).rows[0].userid;
  const deadline = new Date(Date.now() - 3600000),
    start = new Date(deadline.getTime() - 3600000),
    end = new Date(deadline.getTime() + 3600000);
  for (const [kind, ontime] of [
    ["account_created", true],
    ["waiver_expiring", true],
    ["certification_expiring", false],
    ["membership_expiring", true],
  ] as const) {
    const key = randomUUID();
    await pool.query(
      `INSERT INTO app_notification_outbox(userid,kind,dedupe_key,status,deadline_at,accepted_at,provider_message_id) VALUES($1,$2,$3,'accepted',$4,$5,$3)`,
      [
        user,
        kind,
        key,
        deadline,
        new Date(deadline.getTime() + (ontime ? -1000 : 1000)),
      ],
    );
    for (let n = 0; n < 2; n++)
      await pool.query(
        `INSERT INTO app_brevo_delivery_event(event_key,provider_message_id,event_type,occurred_at) VALUES($1,$2,'delivered',$3)`,
        [
          randomUUID(),
          key,
          new Date(deadline.getTime() + (ontime ? -500 : 1500)),
        ],
      );
  }
  // A large successful account cohort must not hide compliance deadline misses.
  await pool.query(
    `INSERT INTO app_notification_outbox(userid,kind,dedupe_key,status,deadline_at,accepted_at)
    SELECT $1,'account_created','unrelated-account-'||n,'accepted',$2,$2::timestamptz-INTERVAL '1 second' FROM generate_series(1,100) n`,
    [user, deadline],
  );
  const m = await notificationMetrics(pool, { from: start, to: end });
  assert.equal(m.eligible, 104);
  assert.equal(m.onTimePercent, (100 * 103) / 104);
  assert.equal(m.delivered, 4);
  assert.equal(m.cohorts.expirationCompliance.eligible, 2);
  assert.equal(m.cohorts.expirationCompliance.onTimePercent, 50);
  assert.equal(m.cohorts.expirationCompliance.deliveryOnTimePercent, 50);
  assert.equal(m.cohorts.expirationCompliance.delivered, 2);
  assert.equal(m.cohorts.membershipExpiration.eligible, 1);
  assert.equal(m.cohorts.other.eligible, 101);
  const empty = await notificationMetrics(pool, {
    from: new Date("2000-01-01"),
    to: new Date("2000-01-02"),
  });
  assert.equal(empty.cohorts.expirationCompliance.eligible, 0);
  assert.equal(empty.cohorts.expirationCompliance.onTimePercent, null);
  assert.equal(empty.cohorts.expirationCompliance.deliveryOnTimePercent, null);
});
