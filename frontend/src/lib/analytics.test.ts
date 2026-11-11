import { expect, test } from "vitest";
import { earlierTotal, periodCoverage, revenuePoints, visitPoints, weekdayCounts } from "./analytics";
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

test("coverage marks the edge periods a range only partly includes", () => {
  // Mon Oct 12 to Tue Nov 10, 2026.
  expect(periodCoverage("2026-10-12", "weekly", "2026-10-12", "2026-11-10")).toEqual({ days: 7, total: 7 });
  expect(periodCoverage("2026-11-09", "weekly", "2026-10-12", "2026-11-10")).toEqual({ days: 2, total: 7 });
  expect(periodCoverage("2026-10-01", "monthly", "2026-10-12", "2026-11-10")).toEqual({ days: 20, total: 31 });
  expect(periodCoverage("2026-11-01", "monthly", "2026-10-12", "2026-11-10")).toEqual({ days: 10, total: 30 });
  expect(periodCoverage("2026-11-10", "daily", "2026-10-12", "2026-11-10")).toEqual({ days: 1, total: 1 });
});

test("visits sum into the same periods as revenue, keeping empty ones", () => {
  const days = [
    { day: "2026-11-04", visits: 9, people: 2 },
    { day: "2026-11-05", visits: 35, people: 3 },
    { day: "2026-11-10", visits: 1, people: 1 },
  ];
  expect(visitPoints("2026-10-26", "2026-11-10", "weekly", days)).toEqual([
    { period: "2026-10-26", visits: 0 },
    { period: "2026-11-02", visits: 44 },
    { period: "2026-11-09", visits: 1 },
  ]);
  expect(visitPoints("2026-10-26", "2026-11-10", "monthly", days)).toEqual([
    { period: "2026-10-01", visits: 0 },
    { period: "2026-11-01", visits: 45 },
  ]);
});

test('earlier totals cover exactly the in-range days of a bar, shifted back', () => {
  const daily = new Map([['2026-09-26', 300], ['2026-10-02', 110], ['2026-10-03', 999], ['2026-10-10', 40]]);
  const range = { from: '2026-10-12', to: '2026-11-10' };
  const earlier = { from: '2026-09-12', to: '2026-10-11' };
  expect(earlierTotal('2026-10-26', 'weekly', range, earlier, daily)).toBe(410);
  // Only Nov 9 and 10 are in range, so only Oct 10 and 11 count.
  expect(earlierTotal('2026-11-09', 'weekly', range, earlier, daily)).toBe(40);
  // "This month" through Mar 31 against February: days past Feb 28 have nothing to compare with.
  expect(earlierTotal('2027-03-01', 'monthly', { from: '2027-03-01', to: '2027-03-31' }, { from: '2027-02-01', to: '2027-02-28' }, new Map([['2027-02-28', 5], ['2027-03-01', 7]]))).toBe(5);
});

test('weekday counts: 30 days ending on a Tuesday holds five Mondays and Tuesdays', () => {
  expect(weekdayCounts('2026-10-12', '2026-11-10')).toEqual([5, 5, 4, 4, 4, 4, 4]);
});
