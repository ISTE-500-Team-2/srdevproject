import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BUSINESS_ZONE, businessToday } from "../src/businessDate.js";

test("business today is the calendar date in the given zone, not UTC", () => {
  const lateEvening = new Date("2026-01-01T03:30:00Z");
  assert.equal(businessToday("America/New_York", lateEvening), "2025-12-31");
  assert.equal(businessToday("UTC", lateEvening), "2026-01-01");
  assert.equal(businessToday("Asia/Tokyo", new Date("2026-06-30T15:30:00Z")), "2026-07-01");
  assert.equal(DEFAULT_BUSINESS_ZONE, "America/New_York");
});
