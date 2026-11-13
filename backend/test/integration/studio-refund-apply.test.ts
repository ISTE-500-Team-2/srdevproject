import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type Stripe from "stripe";
import { transaction } from "../../src/db.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { StudioService } from "../../src/studios/service.js";

const database = "arbor_studio_refund_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const service = new StudioService(pool);
let created = false,
  member: number,
  year = 2040;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  member = (
    await pool.query("SELECT ur.userid FROM user_role ur JOIN role r USING(roleid) WHERE r.role='member' ORDER BY ur.userid LIMIT 1")
  ).rows[0].userid;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

const rental = async (paymentStatus: string, refundId: string | null, status = "cancelled") => {
  year++;
  const pi = "pi_apply_" + randomUUID();
  const row = (
    await pool.query(
      `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,payment_intent,refund_id,refund_cents,request_key,hold_until)
       VALUES(8,$1,$2,$3,20000,'full_before_start',$4,'stripe_test',$5,$6,$7,20000,$8,now()) RETURNING id`,
      [member, `${year}-01-01`, `${year}-02-01`, status, paymentStatus, pi, refundId, randomUUID()],
    )
  ).rows[0];
  return { id: row.id as number, pi };
};
const refund = (r: { id: number; pi: string }, id: string, status: string, extra: Partial<Stripe.Refund> = {}) =>
  ({ id, status, amount: 20000, currency: "usd", payment_intent: r.pi, metadata: { studioRentalId: String(r.id) }, ...extra }) as Stripe.Refund;
const apply = (f: Stripe.Refund) => transaction(pool, (db) => service.applyRefund(db, f));
const state = async (id: number) =>
  (await pool.query("SELECT payment_status,refund_id FROM app_studio_rental WHERE id=$1", [id])).rows[0];
const events = async (id: number) =>
  (await pool.query("SELECT count(*)::int n FROM app_studio_event WHERE rental_id=$1 AND event='stripe_refund_updated'", [id])).rows[0].n;

test("refunds for another amount, rental or uncancelled booking are silently ignored", async () => {
  const r = await rental("refund_pending", null);
  await apply(refund(r, "re_amount_" + r.id, "succeeded", { amount: 10000 }));
  await apply(refund(r, "re_other_" + r.id, "succeeded", { metadata: { studioRentalId: "999999" } }));
  await apply(refund(r, "re_eur_" + r.id, "succeeded", { currency: "eur" }));
  assert.deepEqual(await state(r.id), { payment_status: "refund_pending", refund_id: null });
  const live = await rental("paid", null, "confirmed");
  await apply(refund(live, "re_live_" + live.id, "succeeded"));
  assert.deepEqual(await state(live.id), { payment_status: "paid", refund_id: null });
  assert.equal(await events(r.id) + (await events(live.id)), 0);
});

test("refund updates apply through the shared decision with studio status mapping", async () => {
  const r = await rental("refund_pending", null);
  const first = "re_first_" + r.id,
    second = "re_second_" + r.id;
  await apply(refund(r, first, "canceled"));
  assert.deepEqual(await state(r.id), { payment_status: "refund_failed", refund_id: first });
  // Studio guard: another refund's pending update does not reopen the failure.
  await apply(refund(r, second, "pending"));
  assert.deepEqual(await state(r.id), { payment_status: "refund_failed", refund_id: first });
  // Repeating the recorded state is a no-op.
  await apply(refund(r, first, "failed"));
  assert.equal(await events(r.id), 1);
  await apply(refund(r, second, "succeeded"));
  assert.deepEqual(await state(r.id), { payment_status: "refunded", refund_id: second });
  // A stale failure of the earlier refund cannot downgrade the replacement.
  await apply(refund(r, first, "failed"));
  assert.deepEqual(await state(r.id), { payment_status: "refunded", refund_id: second });
  assert.equal(await events(r.id), 2);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM app_notification_outbox WHERE dedupe_key=$1", [`studio-refund:${r.id}:${second}`])).rows[0].n,
    1,
  );
});
