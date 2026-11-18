// Studio holds: card holds whose checkout never opened, paid-before-cancel checkouts, cancel and
// checkout races, lapsed holds whose webhook was lost, the per-member unpaid-hold cap and the staff
// rental list. Stripe is a local test double.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { StudioService, UNPAID_HOLD_LIMIT } from "../../src/studios/service.js";
import { StudioStripe } from "../../src/studios/stripe.js";

const database = "arbor_studio_holds_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const provider = new StudioStripe({
  key: "sk_test_fixture",
  webhookSecret: "whsec_fixture",
  origin: "http://localhost:8080",
});
const service = new StudioService(pool, "America/New_York", provider);
let created = false,
  member: number,
  admin: number;
const revisions = new Map<number, number>();
const input = (studioId: number, extra = {}) => ({
  studioId,
  startDate: "2030-01-31",
  expectedRevision: revisions.get(studioId),
  paymentMethod: "stripe_test",
  requestKey: randomUUID(),
  ...extra,
});
const row = async (id: number) =>
  (await pool.query("SELECT * FROM app_studio_rental WHERE id=$1", [id])).rows[0];
const pendingOn = async (studioId: number) =>
  (
    await pool.query("SELECT * FROM app_studio_rental WHERE userid=$1 AND studio_id=$2 AND status='pending'", [
      member,
      studioId,
    ])
  ).rows[0];

// Stripe test double: records each checkout creation and the sessions it handed out.
let creates: { params: any; key: string }[] = [],
  expired: string[] = [],
  failCreate = false,
  duringCreate: ((params: any) => Promise<void>) | undefined;
const sessions = new Map<string, any>();
const checkout = provider.sdk.checkout.sessions as any;
checkout.create = async (params: any, options: { idempotencyKey: string }) => {
  creates.push({ params, key: options.idempotencyKey });
  if (failCreate) throw new Error("connection reset");
  await duringCreate?.(params);
  const session = {
    id: `cs_test_${randomBytes(6).toString("hex")}`,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    status: "open",
    payment_status: "unpaid",
    amount_total: params.line_items[0].price_data.unit_amount,
    currency: "usd",
    client_reference_id: params.client_reference_id,
    metadata: params.metadata,
    payment_intent: null,
    expires_at: params.expires_at,
    url: `https://checkout.stripe.com/c/${creates.length}`,
  };
  sessions.set(session.id, session);
  return session;
};
checkout.retrieve = async (id: string) => sessions.get(id);
checkout.expire = async (id: string) => {
  expired.push(id);
  const session = { ...sessions.get(id), status: "expired", url: null };
  sessions.set(id, session);
  return session;
};

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='member@demo.local'`)).rows[0]?.userid;
  admin = (
    await pool.query(`SELECT ur.userid FROM user_role ur JOIN role r USING(roleid) WHERE r.role='admin' LIMIT 1`)
  ).rows[0].userid;
  if (!member) member = (await pool.query("SELECT userid FROM user_membership LIMIT 1")).rows[0].userid;
  await pool.query(
    "UPDATE user_membership SET startdate=now()-interval '1 day',end_date=TIMESTAMP '2031-01-01',status='active' WHERE userid=$1",
    [member],
  );
  for (let i = 1; i <= 8; i++)
    await service.configure(admin, i, {
      monthlyCents: 20000,
      cancellationPolicy: "full_before_start",
      policyConfirmed: true,
      revision: (await pool.query("SELECT revision FROM app_studio WHERE id=$1", [i])).rows[0].revision,
    });
  for (const r of (await pool.query("SELECT id,revision FROM app_studio")).rows) revisions.set(r.id, r.revision);
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});
beforeEach(async () => {
  creates = [];
  expired = [];
  failCreate = false;
  duringCreate = undefined;
  await pool.query("UPDATE app_studio_rental SET status='expired' WHERE userid=$1 AND status='pending'", [member]);
});

test("a card hold whose checkout never opened lapses on time and frees the studio", async () => {
  failCreate = true;
  await assert.rejects(service.create(member, input(1)), { code: "CHECKOUT_UNAVAILABLE" });
  const held = await pendingOn(1);
  assert.equal(held.checkout_id, null);
  await pool.query("UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id=$1", [held.id]);
  await service.list();
  assert.equal((await row(held.id)).status, "expired");
  failCreate = false;
  const again = await service.create(member, input(1));
  assert.equal(again.status, "pending");
  assert.match(again.checkoutUrl!, /^https:\/\/checkout\.stripe\.com/);
});

test("a card hold whose checkout never opened can be cancelled", async () => {
  failCreate = true;
  await assert.rejects(service.create(member, input(2)), { code: "CHECKOUT_UNAVAILABLE" });
  const held = await pendingOn(2);
  const cancelled = await service.cancel(member, held.id);
  assert.equal(cancelled!.status, "cancelled");
  assert.equal(cancelled!.refund_cents, 0);
  assert.equal(cancelled!.payment_status, "unpaid");
});

test("retrying a failed checkout opens one with at least 30 minutes, then replays it", async () => {
  failCreate = true;
  const body = input(3);
  await assert.rejects(service.create(member, body), { code: "CHECKOUT_UNAVAILABLE" });
  const held = await pendingOn(3);
  // Straight away the hold still has its full window, so the retry reuses the same request.
  await assert.rejects(service.syncPayment(member, held.id), { code: "PAYMENT_RECONCILE" });
  assert.equal(creates.length, 2);
  assert.equal(creates[1]!.key, creates[0]!.key);
  // 26 minutes later the old deadline is too close for Stripe's 30-minute minimum.
  await pool.query("UPDATE app_studio_rental SET hold_until=now()+interval '5 minutes' WHERE id=$1", [held.id]);
  failCreate = false;
  const synced = (await service.syncPayment(member, held.id)) as { checkoutUrl?: string | null; status: string };
  assert.equal(synced.status, "pending");
  assert.match(synced.checkoutUrl!, /^https:\/\/checkout\.stripe\.com/);
  const opened = creates.at(-1)!;
  assert.ok(opened.params.expires_at >= Math.floor(Date.now() / 1000) + 30 * 60, "Stripe needs 30 minutes or more");
  assert.equal(opened.key, `studio-checkout:${held.id}:${opened.params.expires_at}`, "the key follows the window");
  const stored = await row(held.id);
  assert.equal(Math.floor(stored.hold_until.getTime() / 1000), opened.params.expires_at);
  assert.ok(sessions.has(stored.checkout_id));
  // The same booking request replays that checkout instead of opening another.
  const replay = await service.create(member, body);
  assert.equal(replay.checkoutUrl, synced.checkoutUrl);
  assert.equal(creates.length, 3);
});

test("a lapsed hold is not revived by a late retry", async () => {
  failCreate = true;
  await assert.rejects(service.create(member, input(4)), { code: "CHECKOUT_UNAVAILABLE" });
  const held = await pendingOn(4);
  await pool.query("UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id=$1", [held.id]);
  failCreate = false;
  const synced = (await service.syncPayment(member, held.id)) as { checkoutUrl?: string | null; status: string };
  assert.equal(synced.status, "expired");
  assert.equal(synced.checkoutUrl, null);
  assert.equal(creates.length, 1);
});

test("a checkout recorded by another request first is the only link handed out", async () => {
  sessions.set("cs_test_recorded_first", {
    id: "cs_test_recorded_first",
    status: "open",
    payment_status: "unpaid",
    url: "https://checkout.stripe.com/c/first",
  });
  duringCreate = async (params) => {
    await pool.query("UPDATE app_studio_rental SET checkout_id='cs_test_recorded_first' WHERE id=$1", [
      Number(params.client_reference_id),
    ]);
  };
  const r = await service.create(member, input(4));
  assert.equal(r.checkoutUrl, "https://checkout.stripe.com/c/first");
  assert.equal((await row(r.id)).checkout_id, "cs_test_recorded_first");
  assert.equal(expired.length, 1, "the extra session is expired, never shown");
  assert.notEqual(expired[0], "cs_test_recorded_first");
});

test("cancelling a hold that was just paid confirms it and stops so the member sees the refund terms", async () => {
  const r = await service.create(member, input(5));
  const session = sessions.get((await row(r.id)).checkout_id);
  // Paid on Stripe, but neither the webhook nor the return sync has run yet.
  sessions.set(session.id, { ...session, status: "complete", payment_status: "paid", payment_intent: `pi_test_${r.id}` });
  await pool.query("UPDATE app_studio_rental SET cancellation_policy='no_refunds' WHERE id=$1", [r.id]);
  await assert.rejects(service.cancel(member, r.id), { code: "PAYMENT_CONFIRMED" });
  let stored = await row(r.id);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.payment_status, "paid");
  // Having seen the real terms, the member can still cancel; the policy decides the refund.
  await service.cancel(member, r.id);
  stored = await row(r.id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.refund_cents, 0);
});

test(`one member can keep at most ${UNPAID_HOLD_LIMIT} unpaid holds at once`, async () => {
  const manual = (studioId: number) => input(studioId, { paymentMethod: "manual", startDate: "2030-03-31" });
  const first = manual(6);
  const holds = [await service.create(member, first), await service.create(member, manual(7))];
  await assert.rejects(service.create(member, manual(8)), { code: "HOLD_LIMIT" });
  assert.equal((await service.create(member, first)).id, holds[0]!.id, "replaying a hold is not a new hold");
  await pool.query("UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id=$1", [holds[0]!.id]);
  assert.equal((await service.create(member, manual(8))).status, "pending");
});

test("the staff list keeps refunds owed and future rentals however many newer rows exist", async () => {
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  const [owed, future, finished] = (
    await pool.query(
      `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,refund_cents,request_key,created_at) VALUES
       (1,$1,'2031-01-01','2031-02-01',20000,'full_before_start','cancelled','manual','refund_pending',20000,$2,now()-interval '2 years'),
       (2,$1,'2031-03-01','2031-04-01',20000,'full_before_start','confirmed','manual','paid',0,$3,now()-interval '2 years'),
       (3,$1,'2020-01-01','2020-02-01',20000,'full_before_start','confirmed','manual','paid',0,$4,now()-interval '2 years') RETURNING id`,
      [member, ...keys],
    )
  ).rows.map((r) => r.id);
  await pool.query(
    `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,request_key,hold_until)
     SELECT 4,$1,'2032-01-01','2032-02-01',20000,'full_before_start','expired','manual',gen_random_uuid(),now() FROM generate_series(1,205)`,
    [member],
  );
  const listed = new Set((await service.staffList(admin)).map((r) => r.id));
  assert.ok(listed.has(owed), "a refund still owed stays on the desk");
  assert.ok(listed.has(future), "a future rental keeps its member name on the board");
  assert.ok(!listed.has(finished), "finished history past the newest 200 is still capped");
});

test("a card payment confirmed after the cancel dialog was drawn stops the cancellation", async () => {
  const r = await service.create(member, input(1, { startDate: "2030-05-31" }));
  await pool.query("UPDATE app_studio_rental SET cancellation_policy='no_refunds' WHERE id=$1", [r.id]);
  const session = sessions.get((await row(r.id)).checkout_id);
  // The member opened the dialog on the unpaid hold; then the webhook (or the return-page sync) confirmed it.
  const paid = { ...session, status: "complete", payment_status: "paid", payment_intent: `pi_test_${r.id}` };
  sessions.set(session.id, paid);
  await service.complete(paid);
  await assert.rejects(service.cancel(member, r.id, { expectedStatus: "pending", expectedPaymentStatus: "unpaid" }), {
    code: "TERMS_CHANGED",
  });
  let stored = await row(r.id);
  assert.equal(stored.status, "confirmed", "a paid rental is not cancelled under terms the member never saw");
  assert.equal(stored.payment_status, "paid");
  // Shown the paid terms, the member can still cancel; the policy decides the refund.
  await service.cancel(member, r.id, { expectedStatus: "confirmed", expectedPaymentStatus: "paid" });
  stored = await row(r.id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.refund_cents, 0);
});

test("a desk payment recorded after the cancel dialog was drawn stops the cancellation", async () => {
  const r = await service.create(member, input(2, { startDate: "2030-05-31", paymentMethod: "manual" }));
  await pool.query("UPDATE app_studio_rental SET cancellation_policy='no_refunds' WHERE id=$1", [r.id]);
  await service.manualPay(admin, r.id, "RCPT-1001");
  await assert.rejects(service.cancel(member, r.id, { expectedStatus: "pending", expectedPaymentStatus: "unpaid" }), {
    code: "TERMS_CHANGED",
  });
  const stored = await row(r.id);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.payment_status, "paid");
  await assert.rejects(service.cancel(member, r.id, { expectedStatus: "pending", expectedPaymentStatus: "nope" }), {
    code: "INVALID_INPUT",
  });
});

test("a hold cancelled while its checkout is being created never gets a payment link", async () => {
  // The member cancels the new hold from another tab while Stripe is still creating its checkout.
  duringCreate = async (params) => {
    await service.cancel(member, Number(params.client_reference_id));
  };
  const r = await service.create(member, input(3, { startDate: "2030-05-31" }));
  assert.equal(r.checkoutUrl, null);
  assert.equal(r.status, "cancelled", "the response says the hold ended, not that it is held");
  assert.equal(creates.length, 1);
  assert.equal(expired.length, 1, "the session created for the cancelled hold is expired");
  assert.equal(sessions.get(expired[0]!).client_reference_id, String(r.id));
  assert.equal((await row(r.id)).checkout_id, null);
});

test("cancelling stops when a checkout opened after the hold was first read", async () => {
  failCreate = true;
  await assert.rejects(service.create(member, input(4, { startDate: "2030-05-31" })), { code: "CHECKOUT_UNAVAILABLE" });
  const held = await pendingOn(4);
  assert.equal(held.checkout_id, null);
  // Between cancel()'s first read and its locked read, a Finish card payment retry opens a checkout.
  const query = pool.query;
  let opened = false;
  (pool as any).query = async (...args: any[]) => {
    const result = await (query as any).apply(pool, args);
    if (!opened && args[0] === "SELECT * FROM app_studio_rental WHERE id=$1 AND userid=$2") {
      opened = true;
      await (query as any).call(pool, "UPDATE app_studio_rental SET checkout_id='cs_test_opened_meanwhile' WHERE id=$1", [
        held.id,
      ]);
    }
    return result;
  };
  try {
    await assert.rejects(service.cancel(member, held.id), { code: "PAYMENT_PROCESSING" });
  } finally {
    delete (pool as any).query;
  }
  assert.ok(opened);
  assert.equal((await row(held.id)).status, "pending", "a hold whose payment link may be in use is not cancelled");
});

test("card holds whose Stripe verdict never arrived are settled once their deadline passes", async () => {
  const startDate = "2030-07-31";
  const paid = await service.create(member, input(5, { startDate }));
  const lapsed = await service.create(member, input(6, { startDate }));
  const paidSession = sessions.get((await row(paid.id)).checkout_id);
  sessions.set(paidSession.id, { ...paidSession, status: "complete", payment_status: "paid", payment_intent: `pi_test_${paid.id}` });
  const lapsedSession = sessions.get((await row(lapsed.id)).checkout_id);
  sessions.set(lapsedSession.id, { ...lapsedSession, status: "expired", url: null });
  // Both webhooks were lost. A hold still inside its window is left alone.
  await service.reconcileLapsedHolds();
  assert.equal((await row(paid.id)).status, "pending");
  assert.equal((await row(lapsed.id)).status, "pending");
  await pool.query("UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id = ANY($1)", [
    [paid.id, lapsed.id],
  ]);
  await service.reconcileLapsedHolds();
  const settled = await row(paid.id);
  assert.equal(settled.status, "confirmed", "a paid checkout is confirmed, never released");
  assert.equal(settled.payment_status, "paid");
  assert.equal((await row(lapsed.id)).status, "expired");
  assert.equal((await service.create(member, input(6, { startDate }))).status, "pending", "the studio is free again");

  // A provider error keeps the hold for the next pass and logs no message or body.
  const stuck = await service.create(member, input(7, { startDate }));
  await pool.query("UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id=$1", [stuck.id]);
  const retrieve = checkout.retrieve;
  checkout.retrieve = async () => {
    throw new TypeError("secret provider body");
  };
  const logged = mock.method(console, "error", () => {});
  try {
    await service.reconcileLapsedHolds();
    assert.equal((await row(stuck.id)).status, "pending");
    assert.match(String(logged.mock.calls[0]!.arguments[0]), /Studio hold reconciliation deferred/);
    assert.doesNotMatch(JSON.stringify(logged.mock.calls.map((c) => c.arguments)), /secret provider body/);
  } finally {
    logged.mock.restore();
    checkout.retrieve = retrieve;
  }
  // The failure is backed off; once that wait is over, the next pass settles the hold.
  assert.equal((await row(stuck.id)).reconcile_failures, 1);
  await pool.query("UPDATE app_studio_rental SET reconcile_after=now()-interval '1 second' WHERE id=$1", [stuck.id]);
  await service.reconcileLapsedHolds();
  assert.equal((await row(stuck.id)).status, "expired", "an open checkout past the deadline is expired, then released");
  assert.ok(expired.includes((await row(stuck.id)).checkout_id));
});

test("lapsed holds that fail on every pass back off, so a newer lapsed hold behind them is still settled", async () => {
  // Twenty older holds whose checkout Stripe no longer has (test data deleted or the key moved to
  // another account), and a newer one whose checkout expired but whose webhook was lost.
  const holds: { id: number; checkout: string }[] = [];
  for (let i = 0; i < 21; i++) {
    const checkoutId = `cs_test_backoff_${i}_${randomBytes(4).toString("hex")}`;
    const id = (
      await pool.query(
        `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,payment_method,request_key,checkout_id,hold_until)
         VALUES(8,$1,DATE '2033-01-01'+make_interval(months=>$2),DATE '2033-01-01'+make_interval(months=>$2+1),20000,'full_before_start','stripe_test',$3,$4,now()-make_interval(mins=>60-$2))
         RETURNING id`,
        [member, i, randomUUID(), checkoutId],
      )
    ).rows[0].id;
    sessions.set(checkoutId, {
      id: checkoutId, object: "checkout.session", livemode: false, mode: "payment", status: "expired", payment_status: "unpaid",
      amount_total: 20000, currency: "usd", client_reference_id: String(id), metadata: { studioRentalId: String(id) },
      payment_intent: null, url: null,
    });
    holds.push({ id, checkout: checkoutId });
  }
  const blocked = holds.slice(0, 20),
    abandoned = holds[20]!;
  const missing = new Set(blocked.map((hold) => hold.checkout)),
    lookups = new Map<string, number>();
  const looked = (hold: { checkout: string }) => lookups.get(hold.checkout) ?? 0;
  const backoff = async () =>
    (
      await pool.query(
        `SELECT reconcile_failures AS failures,round(extract(epoch FROM reconcile_after-now())/60)::int AS minutes
         FROM app_studio_rental WHERE id=ANY($1) ORDER BY id`,
        [blocked.map((hold) => hold.id)],
      )
    ).rows;
  const retrieve = checkout.retrieve;
  checkout.retrieve = async (id: string) => {
    lookups.set(id, (lookups.get(id) ?? 0) + 1);
    if (missing.has(id))
      throw Object.assign(new Error("No such checkout.session"), { type: "StripeInvalidRequestError", code: "resource_missing" });
    return sessions.get(id);
  };
  const logged = mock.method(console, "error", () => {});
  try {
    // The batch is full of failing holds, oldest first; each failure is recorded and backed off.
    await service.reconcileLapsedHolds();
    assert.equal(looked(abandoned), 0);
    assert.deepEqual(await backoff(), blocked.map(() => ({ failures: 1, minutes: 1 })));
    assert.equal((await row(abandoned.id)).status, "pending");

    // While they wait out their backoff, the newer hold gets a slot and is released.
    await service.reconcileLapsedHolds();
    assert.equal(looked(abandoned), 1);
    assert.equal((await row(abandoned.id)).status, "expired");
    assert.ok(blocked.every((hold) => looked(hold) === 1), "failing holds are not rechecked during their backoff");

    // Each further failure waits twice as long, and only failing holds are retried.
    await pool.query("UPDATE app_studio_rental SET reconcile_after=now()-interval '1 second' WHERE id=ANY($1)", [
      blocked.map((hold) => hold.id),
    ]);
    await service.reconcileLapsedHolds();
    assert.deepEqual(await backoff(), blocked.map(() => ({ failures: 2, minutes: 2 })));
    assert.equal(logged.mock.callCount(), 40);

    // Finish card payment still checks a backed-off hold at once.
    missing.delete(blocked[0]!.checkout);
    assert.equal((await service.syncPayment(member, blocked[0]!.id)).status, "expired");
  } finally {
    logged.mock.restore();
    checkout.retrieve = retrieve;
  }
});
