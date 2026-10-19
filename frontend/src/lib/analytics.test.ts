import { expect, test } from "vitest";
import { revenuePoints } from "./analytics";
const row = (period: string, gross: string, refunds = "0", net = gross) => ({
  period,
  gross,
  refunds,
  net,
  receipts: 1,
  category: "Membership",
  method: "cash",
});
test("weekly buckets retain zero weeks and put adjacent periods in chronological order", () => {
  const points = revenuePoints("2026-10-05", "2026-10-25", "weekly", [
    row("2026-10-19", "20"),
    row("2026-10-05", "10"),
  ]);
  expect(points.map((p) => p.period)).toEqual([
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
  ]);
  expect(points.map((p) => p.gross)).toEqual([10, 0, 20]);
});
test("all report categories and more than one payment-history page are summed in cents", () => {
  const points = revenuePoints("2026-10-19", "2026-10-19", "daily", [
    ...Array.from({ length: 120 }, () => row("2026-10-19", "0.10")),
    row("2026-10-19", "20", "20", "0"),
  ]);
  expect(points[0]).toEqual({
    period: "2026-10-19",
    gross: 32,
    refunds: 20,
    net: 12,
    receipts: 121,
  });
});
test("period boundary is assigned once; partial weeks align with PostgreSQL Monday buckets", () => {
  const points = revenuePoints("2026-10-11", "2026-10-12", "weekly", [
    row("2026-10-05", "10"),
    row("2026-10-12", "7"),
  ]);
  expect(points.map((p) => p.gross)).toEqual([10, 7]);
});
test("monthly buckets cross year and leap-day boundaries without local-time drift", () => {
  expect(
    revenuePoints("2023-12-31", "2024-03-01", "monthly", []).map(
      (p) => p.period,
    ),
  ).toEqual(["2023-12-01", "2024-01-01", "2024-02-01", "2024-03-01"]);
});
test("empty reports still contain every selected day and reject bad ranges", () => {
  expect(
    revenuePoints("2026-10-19", "2026-10-21", "daily", []).map((p) => p.net),
  ).toEqual([0, 0, 0]);
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-10-21", "2026-10-19"],
    ["2026-01-01", "2026-12-31"],
  ])
    expect(() => revenuePoints(from, to, "daily", [])).toThrow();
});
