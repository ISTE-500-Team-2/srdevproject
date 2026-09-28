import assert from "node:assert/strict";
import { test } from "node:test";
import { monthlyWindow, refundDue } from "../src/studios/domain.js";
test("anniversary month clamps end of month, leap years and invalid dates", () => {
  assert.deepEqual(monthlyWindow("2028-01-31", "2027-01-01"), {
    start: "2028-01-31",
    end: "2028-02-29",
  });
  assert.equal(monthlyWindow("2027-01-31", "2027-01-01").end, "2027-02-28");
  assert.equal(monthlyWindow("2027-12-31", "2027-01-01").end, "2028-01-31");
  assert.throws(() => monthlyWindow("2027-02-30", "2027-01-01"));
  assert.throws(() => monthlyWindow("2026-01-01", "2027-01-01"));
});
test("refund terms distinguish start day and no-refund terms", () => {
  const r = {
    starts_on: "2030-01-01",
    amount_cents: 12300,
    cancellation_policy: "full_before_start",
  };
  assert.equal(refundDue(r, "2029-12-31"), 12300);
  assert.equal(refundDue(r, "2030-01-01"), 0);
  assert.equal(
    refundDue({ ...r, cancellation_policy: "no_refunds" }, "2029-12-31"),
    0,
  );
});

test("refund adapter reconciles terminal failures without issuing a second refund", async () => {
  const {StudioStripe} = await import('../src/studios/stripe.js');
  const provider = new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
  let created = 0;
  provider.sdk.refunds.create = (async () => {created++; throw Error('must not create')}) as any;
  for(const status of ['failed','canceled','succeeded','pending']) {
    provider.sdk.refunds.list = (async () => ({data:[{id:'re_1',metadata:{studioRentalId:'1'},amount:200,status}]})) as any;
    assert.equal((await provider.refund({id:1,payment_intent:'pi_1',refund_cents:200})).status,status);
  }
  assert.equal(created,0);
});


test("dashboard refund recovery trusts successful original-intent full refund, not stale failure", async () => {
 const {StudioStripe} = await import('../src/studios/stripe.js');
 const provider = new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
 provider.sdk.refunds.list = (async (params: any) => {assert.equal(params.payment_intent,'pi_original');return {data:[
 {id:'re_failed',status:'failed',currency:'usd',amount:200,metadata:{studioRentalId:'1'}},
 {id:'re_dashboard',status:'succeeded',currency:'usd',amount:200,metadata:{}}
 ]}}) as any;
 provider.sdk.refunds.create = (async () => {throw Error('must not issue duplicate')}) as any;
 const found = await provider.refund({id:1,payment_intent:'pi_original',refund_cents:200});
 assert.equal(found.id,'re_dashboard');assert.equal(found.metadata.studioRentalId,'1');
});
