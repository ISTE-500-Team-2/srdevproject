import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type Stripe from "stripe";
import { MembershipBilling } from "../../src/billing/service.js";
import { transaction } from "../../src/db.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { StaffService } from "../../src/services/StaffService.js";
import { stripeObject } from "../helpers/stripeFixtures.js";

// Staff status changes on memberships and passes: a cancelled pass stays closed, and a card
// membership's renewal never undoes what staff decided.
const database = "arbor_entitlement_status_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const zone = "America/New_York";
const staff = new StaffService(pool, zone);
const billing = new MembershipBilling(pool);
let created = false,
  adminId: number,
  plan: { id: number; name: string };

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  adminId = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  plan = (await pool.query("SELECT tierid AS id,tiername AS name FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0];
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

const member = (name: string) =>
  new UserModel(pool).create({
    firstName: name,
    lastName: "Status",
    email: `${name.toLowerCase()}-${randomUUID()}@example.invalid`,
    phone: "555-0104",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
const revision = async (table: "user_membership" | "day_pass", id: number) =>
  (await pool.query(`SELECT revision FROM ${table} WHERE ${table === "day_pass" ? "dayid" : "membershipid"}=$1`, [id])).rows[0].revision as number;

test("a day pass the member cancelled can't be switched back on, suspended or ended by staff", async () => {
  const userId = await member("Cancelled");
  const id = (
    await pool.query(
      `INSERT INTO day_pass(userid,tierid,validdate,purchasedate,status,statusdesc,plan_snapshot)
      SELECT $1,tierid,CURRENT_DATE+5,NOW() AT TIME ZONE 'UTC','cancelled','Member cancellation with 3 days notice',jsonb_build_object('name',tiername)
      FROM membership_tiers WHERE kind='day_pass' LIMIT 1 RETURNING dayid`,
      [userId],
    )
  ).rows[0].dayid as number;
  const rev = await revision("day_pass", id);
  for (const status of ["active", "suspended", "revoked"])
    await assert.rejects(staff.entitlementStatus(adminId, userId, "day_pass", id, status, rev, "Reopen it"), {
      code: "ENTITLEMENT_CLOSED",
      message: "This day pass is cancelled. Issue a new one instead of changing it.",
    });
  const row = (await pool.query("SELECT status,revision FROM day_pass WHERE dayid=$1", [id])).rows[0];
  assert.deepEqual(row, { status: "cancelled", revision: rev });
});

test("card membership: ending access waits for renewal to stop, and a renewal keeps a suspension or ending", async () => {
  const userId = await member("Carded");
  const subscription = "sub_" + randomUUID(),
    customer = "cus_" + randomUUID();
  const billingId = randomUUID();
  await pool.query(
    `INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,subscription_id,customer_id,status)
    VALUES($1,$2,$3,$4,5000,$5,$6,'active')`,
    [billingId, userId, plan.id, JSON.stringify({ id: plan.id, name: plan.name, price: "50.00", kind: "membership", months: 1 }), subscription, customer],
  );
  // One paid month per call, back to back from 2030-01-01.
  let month = 0;
  const pay = async () => {
    const start = Date.UTC(2030, month, 1) / 1000,
      end = Date.UTC(2030, month + 1, 1) / 1000,
      id = `in_${month}_${randomUUID()}`;
    const reason = month === 0 ? "subscription_create" : "subscription_cycle";
    month++;
    const invoice = stripeObject<Stripe.Invoice>({
      id, livemode: false, status: "paid", currency: "usd", customer, amount_paid: 5000, billing_reason: reason,
      parent: { subscription_details: { subscription } },
      lines: { has_more: false, data: [{ amount: 5000, period: { start, end } }] },
    });
    await transaction(pool, async (db) => {
      const row = (await db.query("SELECT * FROM app_membership_billing WHERE id=$1", [billingId])).rows[0];
      await billing.invoicePaid(db, invoice, row);
    });
    return (await pool.query(
      `SELECT m.membershipid AS id,m.status,m.statusdesc AS reason FROM app_membership_invoice i
      JOIN user_membership m ON m.membershipid=i.membership_id WHERE i.id=$1`,
      [id],
    )).rows[0] as { id: number; status: string; reason: string };
  };
  const change = async (id: number, status: string, reason: string) =>
    staff.entitlementStatus(adminId, userId, "membership", id, status, await revision("user_membership", id), reason);

  const january = await pay();
  assert.equal(january.status, "active");
  // Ending access while the card still renews would keep charging for a period that stays ended.
  await assert.rejects(change(january.id, "revoked", "Banned"), {
    code: "CARD_RENEWAL_ACTIVE",
    message: /stop auto-renew/,
  });
  assert.equal((await pool.query("SELECT status FROM user_membership WHERE membershipid=$1", [january.id])).rows[0].status, "active");

  // A suspension is allowed (billing carries on, as staff are told) and survives the renewal.
  await change(january.id, "suspended", "Hold for review");
  const february = await pay();
  assert.deepEqual([february.status, february.reason], ["suspended", "Hold for review"]);

  // Lifting it on the current month lets the next month start active again.
  await change(february.id, "active", "Review done");
  const march = await pay();
  assert.equal(march.status, "active");

  // Once auto-renew is stopped, staff can end access, and a last paid month stays ended.
  await pool.query("UPDATE app_membership_billing SET cancellation_effective_at=now()+interval '30 days' WHERE id=$1", [billingId]);
  await change(march.id, "revoked", "Banned");
  const april = await pay();
  assert.deepEqual([april.status, april.reason], ["revoked", "Banned"]);
});

test("ending a desk-paid membership needs no renewal step", async () => {
  const userId = await member("Desk");
  const id = (
    await pool.query(
      `INSERT INTO user_membership(userid,tierid,startdate,end_date,status) VALUES($1,$2,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active') RETURNING membershipid`,
      [userId, plan.id],
    )
  ).rows[0].membershipid as number;
  const after = await staff.entitlementStatus(adminId, userId, "membership", id, "revoked", await revision("user_membership", id), "Banned");
  assert.equal(after.status, "revoked");
});
