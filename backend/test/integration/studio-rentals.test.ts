import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { StudioService } from "../../src/studios/service.js";
import { StudioStripe } from "../../src/studios/stripe.js";
import { createApp } from "../../src/app.js";
const database = "arbor_studio_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const service = new StudioService(pool);
let created = false,
  member: number,
  admin: number;
const input = (studioId: number, extra = {}) => ({
  studioId,
  startDate: "2030-01-31",
  expectedRevision: 2,
  paymentMethod: "manual",
  requestKey: randomUUID(),
  ...extra,
});
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  member = (
    await pool.query(
      `SELECT userid FROM "user" WHERE email='member@demo.local'`,
    )
  ).rows[0]?.userid;
  admin = (
    await pool.query(
      `SELECT ur.userid FROM user_role ur JOIN role r USING(roleid) WHERE r.role='admin' LIMIT 1`,
    )
  ).rows[0].userid;
  if (!member)
    member = (await pool.query("SELECT userid FROM user_membership LIMIT 1"))
      .rows[0].userid;
  await pool.query(
    "UPDATE user_membership SET startdate=now()-interval '1 day',end_date=TIMESTAMP '2031-01-01',status='active' WHERE userid=$1",
    [member],
  );
  for (let i = 1; i <= 8; i++)
    await service.configure(admin, i, {
      monthlyCents: 20000,
      cancellationPolicy: "full_before_start",
      policyConfirmed: true,
      revision: 1,
    });
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});
test("one winner in concurrent monthly bookings; manual payment requires staff; cancellation/refund truthful", async () => {
  const results = await Promise.allSettled([
    service.create(member, input(1)),
    service.create(member, input(1)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.code,
    "STUDIO_CONFLICT",
  );
  const rental = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  assert.equal(rental.payment_status, "unpaid");
  assert.equal(rental.ends_on, "2030-02-28");
  await assert.rejects(service.manualPay(member, rental.id, "fake receipt"), {
    code: "STAFF_REQUIRED",
  });
  await service.manualPay(admin, rental.id, "cash receipt 123");
  assert.equal((await service.mine(member))[0].payment_status, "paid");
  await service.cancel(member, rental.id);
  assert.equal(
    (await service.mine(member))[0].payment_status,
    "refund_pending",
  );
  await assert.rejects(service.manualRefund(member, rental.id, "fake refund"), {
    code: "STAFF_REQUIRED",
  });
  await service.manualRefund(admin, rental.id, "cash refund 123");
  assert.equal((await service.mine(member))[0].payment_status, "refunded");
  await service.create(member, input(1));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_notification_outbox WHERE dedupe_key=$1",
        [`studio:${rental.id}:studio_reservation_confirmed`],
      )
    ).rows[0].n,
    1,
  );
});
test("same request is idempotent, changes rejected, unconfigured studio and nonmonthly users blocked", async () => {
  const data = input(2);
  const first = await service.create(member, data),
    second = await service.create(member, data);
  assert.equal(first.id, second.id);
  await assert.rejects(
    service.create(member, { ...data, startDate: "2030-03-01" }),
    { code: "KEY_REUSED" },
  );
  await pool.query("UPDATE app_studio SET policy_confirmed=false WHERE id=3");
  await assert.rejects(service.create(member, input(3)), {
    code: "STUDIO_NOT_CONFIGURED",
  });
  await pool.query(
    "UPDATE user_membership SET status='expired' WHERE userid=$1",
    [member],
  );
  await assert.rejects(service.create(member, input(4)), {
    code: "MONTHLY_REQUIRED",
  });
  await pool.query(
    "UPDATE user_membership SET status='active' WHERE userid=$1",
    [member],
  );
});
test("expired manual holds free space; instructor denied; stale price rejected", async () => {
  const r = await service.create(member, input(4));
  await pool.query(
    "UPDATE app_studio_rental SET hold_until=now()-interval '1 second' WHERE id=$1",
    [r.id],
  );
  await assert.rejects(service.manualPay(admin, r.id, "late receipt"), {
    code: "PAYMENT_STATE",
  });
  await service.create(member, input(4));
  await assert.rejects(
    service.create(member, input(5, { expectedRevision: 1 })),
    { code: "PRICE_CHANGED" },
  );
  await pool.query(
    "INSERT INTO role(roleid,role) VALUES(9999,'instructor') ON CONFLICT DO NOTHING",
  );
  await pool.query("INSERT INTO user_role(userid,roleid) VALUES($1,9999)", [
    member,
  ]);
  await assert.rejects(service.create(member, input(5)), {
    code: "INSTRUCTOR_RESERVATION",
  });
  await pool.query("DELETE FROM user_role WHERE userid=$1 AND roleid=9999", [
    member,
  ]);
});
test("signed Stripe callback confirms only matching paid test session and deduplicates", async () => {
  const provider = new StudioStripe({
    key: "sk_test_unit_fake",
    webhookSecret: "whsec_unit_secret",
    origin: "http://localhost:8080",
  });
  const stripeService = new StudioService(pool, "America/New_York", provider);
  const r = await service.create(member, input(6));
  await pool.query(
    "UPDATE app_studio_rental SET payment_method='stripe_test',checkout_id='cs_test_good' WHERE id=$1",
    [r.id],
  );
  const session: any = {
    id: "cs_test_good",
    object: "checkout.session",
    livemode: false,
    payment_status: "paid",
    client_reference_id: String(r.id),
    metadata: { studioRentalId: String(r.id) },
    amount_total: 20000,
    currency: "usd",
    payment_intent: "pi_test_good",
  };
  await assert.rejects(
    stripeService.complete({ ...session, amount_total: 1 }),
    { code: "PAYMENT_MISMATCH" },
  );
  const app = createApp(pool, {
    port: 8080,
    host: "127.0.0.1",
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: ["http://localhost:8080"],
    timeZone: "America/New_York",
    jwtKey: randomBytes(32),
    studioStripe: provider.config,
  });
  const event = {
    id: "evt_studio_1",
    object: "event",
    livemode: false,
    type: "checkout.session.completed",
    data: { object: session },
  };
  const payload = JSON.stringify(event);
  let response = await request(app)
    .post("/api/webhooks/stripe-studios")
    .set("Content-Type", "application/json")
    .send(payload);
  assert.equal(response.status, 400);
  const signature = provider.sdk.webhooks.generateTestHeaderString({
    payload,
    secret: provider.config.webhookSecret,
  });
  for (let i = 0; i < 2; i++) {
    response = await request(app)
      .post("/api/webhooks/stripe-studios")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(payload);
    assert.equal(response.status, 200, response.text);
  }
  assert.equal(
    (
      await pool.query(
        "SELECT payment_status FROM app_studio_rental WHERE id=$1",
        [r.id],
      )
    ).rows[0].payment_status,
    "paid",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_notification_outbox WHERE dedupe_key=$1",
        [`studio:${r.id}:studio_reservation_confirmed`],
      )
    ).rows[0].n,
    1,
  );
});

test("test checkout reconciles paid sessions; refund failures stay visible and retries do not duplicate", async () => {
  const provider = new StudioStripe({
    key: "sk_test_local_fixture",
    webhookSecret: "whsec_fixture",
    origin: "http://localhost:8080",
  });
  const svc = new StudioService(pool, "America/New_York", provider);
  let created: any,
    refundCalls = 0,
    failRefund = true;
  provider.sdk.checkout.sessions.create = (async (data: any) => {
    created = {
      ...data,
      id: "cs_test_checkout",
      object: "checkout.session",
      livemode: false,
      status: "open",
      payment_status: "unpaid",
      amount_total: 20000,
      currency: "usd",
      payment_intent: "pi_test_checkout",
      url: "https://checkout.stripe.com/test_fixture",
    };
    return created;
  }) as any;
  provider.sdk.checkout.sessions.retrieve = (async () => created) as any;
  provider.sdk.refunds.list = (async () => ({ data: [] })) as any;
  provider.sdk.refunds.create = (async () => {
    refundCalls++;
    if (failRefund) throw Error("network failed");
    return {
      id: "re_test_refund",
      amount: 20000,
      currency: "usd",
      payment_intent: "pi_test_checkout",
      metadata: { studioRentalId: created.metadata.studioRentalId },
      status: "succeeded",
    };
  }) as any;
  const r = await svc.create(
    member,
    input(7, { paymentMethod: "stripe_test" }),
  );
  assert.equal(r.payment_status, "unpaid");
  assert.match(r.checkoutUrl!, /^https:\/\/checkout.stripe.com/);
  created = { ...created, status: "complete", payment_status: "paid" };
  await svc.syncPayment(member, r.id);
  assert.equal(
    (
      await pool.query("SELECT status FROM app_studio_rental WHERE id=$1", [
        r.id,
      ])
    ).rows[0].status,
    "confirmed",
  );
  await assert.rejects(svc.cancel(member, r.id), { code: "REFUND_PENDING" });
  assert.equal(
    (
      await pool.query(
        "SELECT payment_status,status FROM app_studio_rental WHERE id=$1",
        [r.id],
      )
    ).rows[0].payment_status,
    "refund_failed",
  );
  failRefund = false;
  await svc.retryRefund(r.id);
  await svc.retryRefund(r.id);
  assert.equal(refundCalls, 2);
  assert.equal(
    (
      await pool.query(
        "SELECT payment_status FROM app_studio_rental WHERE id=$1",
        [r.id],
      )
    ).rows[0].payment_status,
    "refunded",
  );
  const stale: any = {
    id: "evt_old_pending_refund",
    livemode: false,
    type: "refund.updated",
    data: {
      object: {
        id: "re_test_refund",
        amount: 20000,
        currency: "usd",
        payment_intent: "pi_test_checkout",
        metadata: { studioRentalId: String(r.id) },
        status: "pending",
      },
    },
  };
  await svc.webhook(stale);
  assert.equal(
    (
      await pool.query(
        "SELECT payment_status FROM app_studio_rental WHERE id=$1",
        [r.id],
      )
    ).rows[0].payment_status,
    "refunded",
  );
});

test('revoked own reservation grant blocks studio create inside transaction', async () => {
 await pool.query(`UPDATE role_permission SET isallowed=false WHERE roleid=(SELECT roleid FROM role WHERE role='member') AND permissionid=(SELECT permissionid FROM permission WHERE permissionname='create') AND resourcename='reservation' AND scopetype='personal'`);
 try {await assert.rejects(service.create(member,input(8)),{code:'PERMISSION_DENIED'});}
 finally {await pool.query(`UPDATE role_permission SET isallowed=true WHERE roleid=(SELECT roleid FROM role WHERE role='member') AND permissionid=(SELECT permissionid FROM permission WHERE permissionname='create') AND resourcename='reservation' AND scopetype='personal'`);}
});
test('unrelated checkout events are acknowledged without claiming a studio rental', async () => {
 await service.webhook({id:'evt_unrelated',livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_membership',payment_status:'paid',metadata:{membershipId:'123'}}}} as any);
});
test('terminal provider refund failure is persisted and requires reconciliation, not endless retry', async () => {
 const provider = new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
 const svc = new StudioService(pool,'America/New_York',provider);
 const r = (await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,payment_intent,refund_cents,request_key,hold_until) VALUES(8,$1,'2032-01-01','2032-02-01',20000,'full_before_start','cancelled','stripe_test','refund_pending','pi_terminal',20000,$2,now()) RETURNING *`,[member,randomUUID()])).rows[0];
 for(const status of ['failed','canceled']) {
 provider.refund = (async () => ({id:'re_terminal',metadata:{studioRentalId:String(r.id)},amount:20000,currency:'usd',payment_intent:'pi_terminal',status})) as any;
 await assert.rejects(svc.retryRefund(r.id),{code:'REFUND_RECONCILE'});
 assert.equal((await pool.query('SELECT payment_status FROM app_studio_rental WHERE id=$1',[r.id])).rows[0].payment_status,'refund_failed');
 }
});

// Ticket FR-029/FR-030: acceptance is queue delivery, not a claim of inbox delivery.
test('studio notices wait for payment, target member and staff once, and respect opt-outs', async () => {
 const rental=await service.create(member,input(8,{startDate:'2030-06-01'}));
 const notices=async(kind:string)=>(await pool.query('SELECT userid,status,payload FROM app_notification_outbox WHERE kind=$1 AND payload->>\'reservationId\'=$2 ORDER BY userid',[kind,String(rental.id)])).rows;
 assert.equal((await notices('studio_reservation_confirmed')).length,0,'a hold is not a confirmed booking');
 await pool.query(`INSERT INTO app_notification_preferences(userid,enabled,time_zone) VALUES($1,false,'America/New_York') ON CONFLICT(userid) DO UPDATE SET enabled=false`,[admin]);
 try {
  await service.manualPay(admin,rental.id,'notification acceptance receipt');
  await assert.rejects(service.manualPay(admin,rental.id,'notification acceptance receipt'),{code:'PAYMENT_STATE'});
  assert.equal((await notices('payment_receipt')).length,1,'staff-recorded payment queues a separate receipt');
  let rows=await notices('studio_reservation_confirmed');
  assert.deepEqual(rows.map(r=>[r.userid,r.status]),[[member,'pending'],[admin,'suppressed']].sort((a,b)=>Number(a[0])-Number(b[0])));
  await service.cancel(member,rental.id);
  await service.cancel(member,rental.id);
  rows=await notices('studio_reservation_cancelled');
  assert.deepEqual(rows.map(r=>[r.userid,r.status]),[[member,'pending'],[admin,'suppressed']].sort((a,b)=>Number(a[0])-Number(b[0])));
  assert.match(rows.find(r=>r.userid===member).payload.instructions,/refund_pending/);
  assert.match(rows.find(r=>r.userid===member).payload.instructions,/original payment method/);
 } finally {await pool.query('UPDATE app_notification_preferences SET enabled=true WHERE userid=$1',[admin]);}
});
