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
