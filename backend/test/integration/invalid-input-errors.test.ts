// Oversized ids, impossible dates and control characters are client mistakes: a 400, never a
// logged server error. Profile saves can't pile fields up across requests.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DisposableApp } from "../helpers/appHarness.js";

const harness = new DisposableApp("arbor_invalid_input_");
before(async () => {
  await harness.setup();
  await harness.start();
});
after(() => harness.teardown());
const client = () => harness.client({ firstName: "Invalid", lastName: "Input" });
const tomorrow = (hour: number) => {
  const day = new Date(Date.now() + 86400000);
  day.setUTCHours(hour, 0, 0, 0);
  return day.toISOString();
};
const profile = (extra: object = {}) => ({ firstName: "Invalid", lastName: "Input", phone: "5551234567", ...extra });

/** Runs `body` and returns whatever it logged as a server error, and the database refusals it noted. */
async function errorsLogged(body: () => Promise<void>, refusals: unknown[] = []) {
  const logged: unknown[] = [];
  const { error, warn } = console;
  console.error = (...args: unknown[]) => { logged.push(args); };
  console.warn = (...args: unknown[]) => {
    if (args[0] === "Request rejected by database") refusals.push(args);
    else warn(...args);
  };
  try {
    await body();
  } finally {
    Object.assign(console, { error, warn });
  }
  return logged;
}

test("ids and revisions past the INTEGER range, and year-0 report dates, are a 400", async () => {
  const admin = client(), member = client();
  await admin.demo("admin");
  await member.register();
  const logged = await errorsLogged(async () => {
    const tooBig = /no greater than 2147483647/;
    const answers = {
      "user record": [await admin.get("/admin/users/3000000000"), tooBig],
      "signed waivers": [await admin.get("/admin/users/3000000000/signed-waivers"), tooBig],
      "tap history": [await admin.get("/admin/access/events?before=3000000000"), tooBig],
      "cancel booking": [await member.post("/reservations/3000000000/cancel"), tooBig],
      "book": [await member.post("/reservations", { equipmentId: 3000000000, startTime: tomorrow(15), endTime: tomorrow(16) }), tooBig],
      "revision": [await admin.post(`/admin/users/${member.id}/status`, { status: "suspended", revision: 3000000000, reason: "Range check" }), tooBig],
      "report": [await admin.get("/admin/reports?from=0000-01-01&to=0000-01-02"), /Choose valid report dates/],
    } as const;
    for (const [what, [res, message]] of Object.entries(answers)) {
      assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "INVALID_INPUT", what);
      assert.match(res.body.error.message, message, what);
    }
    // Change-log record ids are BIGINT, so a large one is simply not found.
    assert.equal((await admin.get("/admin/audit/3000000000")).status, 404);
  });
  assert.deepEqual(logged, []);
});

test("a NUL character in text, profile values, searches or path ids is a 400", async () => {
  const admin = client(), member = client(), visitor = client();
  await admin.demo("admin");
  await member.register();
  const refusals: unknown[] = [];
  const logged = await errorsLogged(async () => {
    const refused = /contains a character that can't be saved/;
    const answers = {
      "sign-up": [await visitor.agent.post("/api/auth/register").send({
        firstName: "A\u0000b", lastName: "B", phone: "5551234567", email: "nul.test@example.invalid",
        dob: "1990-01-01", password: "Abcdefg!1234",
      }), refused],
      "profile name": [await member.patch("/me/profile", profile({ firstName: "Jo\u0000rdan" })), refused],
      "profile address": [await member.patch("/me/profile", profile({ address: { street: "x\u0000y" } })), refused],
      "member search": [await admin.get("/admin/users?search=%00"), refused],
      "reader filter": [await admin.get("/admin/access/events?readerId=%00"), refused],
      // No validator sees this id; the database refuses the NUL and the error handler answers 400.
      "pass id": [await member.post("/me/billing/passes/%00/cancel"), /A value in the request is not valid/],
    } as const;
    for (const [what, [res, message]] of Object.entries(answers)) {
      assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "INVALID_INPUT", what);
      assert.match(res.body.error.message, message, what);
    }
  }, refusals);
  assert.deepEqual(logged, []);
  // Only the pass id reached the database; its refusal leaves a trace with the code and no value.
  assert.deepEqual(refusals, [["Request rejected by database", { code: "22021" }]]);
  const stored = await harness.pool.query(`SELECT firstname FROM "user" WHERE userid=$1`, [member.id]);
  assert.equal(stored.rows[0].firstname, "Invalid");
});

test("profile fields can't pile up past 20 across saves", async () => {
  const member = client();
  await member.register();
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["line" + i, "x"]));
  assert.equal((await member.patch("/me/profile", profile({ address: twenty }))).status, 200);
  const more = await member.patch("/me/profile", profile({ address: { extra: "y" } }));
  assert.equal(more.status, 400);
  assert.equal(more.body.error.message, "Address can contain up to 20 fields.");
  // Replacing one field keeps the total at 20.
  assert.equal((await member.patch("/me/profile", profile({ address: { line0: null, extra: "y" } }))).status, 200);
  const stored = await harness.pool.query(`SELECT profile_address AS address FROM "user" WHERE userid=$1`, [member.id]);
  assert.equal(Object.keys(stored.rows[0].address).length, 20);
  assert.equal(stored.rows[0].address.extra, "y");
});

test("profile saves are rate limited", async () => {
  // A fresh app starts with a fresh allowance.
  await harness.restart();
  const member = client();
  await member.register();
  for (let i = 0; i < 60; i++)
    assert.equal((await member.patch("/me/profile", profile({ address: { note: "save " + i } }))).status, 200);
  const limited = await member.patch("/me/profile", profile());
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "RATE_LIMITED");
  // Counted per account: another member on the same network still saves.
  const neighbour = client();
  await neighbour.register();
  assert.equal((await neighbour.patch("/me/profile", profile())).status, 200);
});
