import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type Stripe from "stripe";
import { MembershipBilling } from "../../src/billing/service.js";
import { transaction } from "../../src/db.js";
import { StaffModel } from "../../src/models/StaffModel.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { StaffService } from "../../src/services/StaffService.js";
import { StudioStripe } from "../../src/studios/stripe.js";
import { stripeMock, stripeObject, type StripeFixture } from "../helpers/stripeFixtures.js";

// Staff status changes on memberships and passes: a cancelled pass stays closed, and a card
// membership's renewal never undoes what staff decided.
const database = "arbor_entitlement_status_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const zone = "America/New_York";
const staff = new StaffService(pool, zone);
const provider = new StudioStripe({ key: "sk_test_fixture", webhookSecret: "whsec_fixture", origin: "http://localhost" });
const billing = new MembershipBilling(pool, provider);
// Each card member's subscription, as Stripe holds it; an update applies its parameters.
const subscriptions = new Map<string, StripeFixture<Stripe.Subscription>>();
const stripe = stripeMock(provider);
stripe.subscriptionRetrieve(async (id) => subscriptions.get(id)!);
stripe.subscriptionUpdate(async (id, params) => {
  const updated = { ...subscriptions.get(id)!, ...(params as StripeFixture<Stripe.Subscription>) };
  subscriptions.set(id, updated);
  return updated;
});
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

/** A member paying monthly by card, and a way to pay their next month (back to back from 2030-01-01). */
async function cardMember(name: string) {
  const userId = await member(name);
  const subscription = "sub_" + randomUUID(),
    customer = "cus_" + randomUUID();
  const billingId = randomUUID();
  await pool.query(
    `INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,subscription_id,customer_id,status)
    VALUES($1,$2,$3,$4,5000,$5,$6,'active')`,
    [billingId, userId, plan.id, JSON.stringify({ id: plan.id, name: plan.name, price: "50.00", kind: "membership", months: 1 }), subscription, customer],
  );
  subscriptions.set(subscription, {
    id: subscription, livemode: false, customer, status: "active", cancel_at_period_end: false,
    billing_cycle_anchor: Date.UTC(2030, 0, 1) / 1000, metadata: { membershipBillingId: billingId },
    items: { data: [{ quantity: 1, current_period_end: Date.UTC(2030, 4, 1) / 1000,
      price: { unit_amount: 5000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  });
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
    const paid = (await pool.query(
      `SELECT m.membershipid AS id,m.status,m.statusdesc AS reason,n.payload->>'instructions' AS receipt FROM app_membership_invoice i
      JOIN user_membership m ON m.membershipid=i.membership_id
      JOIN app_notification_outbox n ON n.dedupe_key='membership-receipt:'||i.id WHERE i.id=$1`,
      [id],
    )).rows[0] as { id: number; status: string; reason: string; receipt: string | null };
    return paid;
  };
  const change = async (id: number, status: string, reason: string) =>
    staff.entitlementStatus(adminId, userId, "membership", id, status, await revision("user_membership", id), reason);
  const listed = async (id: number) => (await new StaffModel(pool, zone).memberships(userId)).find((m) => m.id === id)!;
  return { userId, pay, change, listed };
}
/** The change log's entries about one membership, oldest first, with who made them. */
const audits = async (membershipId: number) =>
  (await pool.query(
    "SELECT actor_id AS actor,action FROM app_staff_audit WHERE entity_type='membership' AND entity_id=$1 AND source='application' ORDER BY id",
    [membershipId],
  )).rows as { actor: number | null; action: string }[];

test("card membership: ending access waits for renewal to stop, and a renewal keeps a suspension or ending", async () => {
  const { userId, pay, change, listed } = await cardMember("Carded");

  const january = await pay();
  assert.deepEqual([january.status, january.receipt], ["active", null]);
  assert.equal((await listed(january.id)).renewing, true);
  // Ending access while the card still renews would keep charging for a period that stays ended.
  await assert.rejects(change(january.id, "revoked", "Banned"), {
    code: "CARD_RENEWAL_ACTIVE",
    message: /Choose Stop auto-renew on Carded’s membership first/,
  });
  assert.equal((await pool.query("SELECT status FROM user_membership WHERE membershipid=$1", [january.id])).rows[0].status, "active");

  // A suspension is allowed (billing carries on, as staff are told) and survives the renewal,
  // recorded as the system's change, and the receipt says the payment doesn't restore access.
  await change(january.id, "suspended", "Hold for review");
  const february = await pay();
  assert.deepEqual([february.status, february.reason], ["suspended", "Hold for review"]);
  assert.match(february.receipt!, /paused your membership access/);
  assert.deepEqual(await audits(february.id), [{ actor: null, action: "entitlement.suspended" }]);

  // Lifting it on the current month lets the next month start active again.
  await change(february.id, "active", "Review done");
  const march = await pay();
  assert.deepEqual([march.status, march.receipt], ["active", null]);

  // Staff stop renewal from the record while the member is on hold and restricted, when their
  // account can't be opened, then end access.
  await pool.query(`UPDATE "user" SET status='suspended',accessstatus='suspended' WHERE userid=$1`, [userId]);
  const stopped = await billing.stopRenewal(adminId, userId, march.id, "Banned");
  assert.equal(stopped.renewing, false);
  assert.equal(new Date(stopped.renewalEndsAt!).getTime(), Date.UTC(2030, 4, 1));
  assert.deepEqual([(await listed(march.id)).renewing, new Date((await listed(march.id)).renewalEndsAt!).getTime()], [false, Date.UTC(2030, 4, 1)]);
  await change(march.id, "revoked", "Banned");
  // Asking again changes nothing and adds nothing to the change log.
  assert.equal((await billing.stopRenewal(adminId, userId, march.id, "Banned")).renewing, false);
  assert.deepEqual(await audits(march.id), [
    { actor: adminId, action: "billing.renewal_stopped" },
    { actor: adminId, action: "entitlement.revoked" },
  ]);

  // The last month paid under the notice stays ended, and isn't flagged: renewal is off.
  const april = await pay();
  assert.deepEqual([april.status, april.reason], ["revoked", "Banned"]);
  assert.equal(april.receipt, "Staff ended your membership access, so this payment doesn’t restore it. Contact the front desk about a refund.");
  assert.deepEqual(await audits(april.id), [{ actor: null, action: "entitlement.revoked" }]);
});

test("a card membership ended before renewal had to stop is flagged each time it charges", async () => {
  const { userId, pay, listed } = await cardMember("Legacy");
  const january = await pay();
  // Ended under the old rules, which didn't ask for renewal to stop first.
  await pool.query("UPDATE user_membership SET status='revoked',statusdesc='Banned',revision=revision+1 WHERE membershipid=$1", [january.id]);
  const february = await pay();
  assert.deepEqual([february.status, february.reason], ["revoked", "Banned"]);
  assert.match(february.receipt!, /Contact the front desk about stopping renewal or a refund\.$/);
  assert.deepEqual(await audits(february.id), [
    { actor: null, action: "entitlement.revoked" },
    { actor: null, action: "billing.charged_after_access_ended" },
  ]);
  // The record shows it still renews, and staff can stop it there.
  assert.equal((await listed(february.id)).renewing, true);
  assert.equal((await billing.stopRenewal(adminId, userId, february.id, "Stop the charges")).renewing, false);
  assert.equal((await listed(february.id)).renewing, false);
});

test("stopping renewal needs a card membership of that member", async () => {
  const { pay } = await cardMember("Owner");
  const other = await member("Other");
  const january = await pay();
  await assert.rejects(billing.stopRenewal(adminId, other, january.id, "Wrong member"), { code: "NOT_FOUND" });
  const desk = (
    await pool.query(
      `INSERT INTO user_membership(userid,tierid,startdate,end_date,status) VALUES($1,$2,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active') RETURNING membershipid`,
      [other, plan.id],
    )
  ).rows[0].membershipid as number;
  await assert.rejects(billing.stopRenewal(adminId, other, desk, "Desk paid"), { code: "NOT_FOUND" });
  await assert.rejects(billing.stopRenewal(adminId, other, desk, ""), { code: "INVALID_INPUT" });
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
