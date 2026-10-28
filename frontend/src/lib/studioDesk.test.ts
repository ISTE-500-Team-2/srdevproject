import { expect, test } from "vitest";
import type { Rental, Studio } from "./studioContracts";
import { deskTasks, monthStarts, openGaps, studioNow, studioSummary, timelineBars } from "./studioDesk";

const rental = (id: number, extra: Partial<Rental>): Rental => ({
  id,
  name: "Paris",
  starts_on: "2026-11-01",
  ends_on: "2026-12-01",
  amount_cents: 40000,
  status: "confirmed",
  payment_status: "paid",
  payment_method: "manual",
  hold_until: "2026-10-30T16:00:00Z",
  refund_cents: 0,
  cancellation_policy: "no_refunds",
  ...extra,
});
const studio = (availability: Studio["availability"], extra: Partial<Studio> = {}): Studio => ({
  id: 1,
  name: "Paris",
  size: "large",
  monthly_cents: 65000,
  cancellation_policy: "full_before_start",
  policy_confirmed: true,
  revision: 1,
  availability,
  ...extra,
});
const slot = (starts_on: string, ends_on: string, status = "confirmed") => ({ starts_on, ends_on, status, hold_until: "2026-10-30T16:00:00Z" });

test("the queue puts desk payments first by hold deadline, then refunds, then card retries", () => {
  const tasks = deskTasks([
    rental(1, { status: "cancelled", payment_status: "refund_failed", payment_method: "stripe_test" }),
    rental(2, { status: "cancelled", payment_status: "refund_pending" }),
    rental(3, { status: "pending", payment_status: "unpaid", hold_until: "2026-11-04T16:00:00Z" }),
    rental(4, { status: "pending", payment_status: "unpaid", hold_until: "2026-10-30T16:00:00Z" }),
    rental(5, {}),
    rental(6, { status: "pending", payment_status: "unpaid", payment_method: "stripe_test" }),
  ]);
  expect(tasks.map((t) => [t.rental.id, t.kind])).toEqual([
    [4, "collect"],
    [3, "collect"],
    [2, "refund"],
    [1, "card"],
  ]);
});

test("a studio's state today follows back-to-back rentals to the first free day", () => {
  const today = "2026-10-28";
  const chained = studio([slot("2026-11-10", "2026-12-10"), slot("2026-10-10", "2026-11-10")]);
  expect(studioNow(chained, today)).toMatchObject({ state: "rented", freeFrom: "2026-12-10" });
  expect(studioNow(studio([slot("2026-10-20", "2026-11-20", "pending")]), today).state).toBe("held");
  const open = studioNow(studio([slot("2026-11-01", "2026-12-01", "pending")]), today);
  expect(open).toMatchObject({ state: "open", freeFrom: today });
  expect(open.next?.starts_on).toBe("2026-11-01");
  // The end date is exclusive: a rental ending today leaves the studio open.
  expect(studioNow(studio([slot("2026-09-28", "2026-10-28")]), today).state).toBe("open");
  expect(studioNow(studio([], { policy_confirmed: false }), today).state).toBe("off");
  expect(studioSummary([chained, studio([]), studio([], { monthly_cents: null })], today)).toEqual({ rented: 1, open: 1, held: 0, off: 1 });
});

test("timeline bars clip to the window and gaps ahead of today read as open", () => {
  const s = studio([slot("2026-10-01", "2026-11-01"), slot("2026-11-15", "2026-12-15", "pending"), slot("2027-03-01", "2027-04-01")]);
  const bars = timelineBars(s, "2026-10-15", 90);
  expect(bars.map((b) => [b.from, b.to, b.clipped])).toEqual([
    [0, 17, true],
    [31, 61, false],
  ]);
  expect(openGaps(bars, 90, 13)).toEqual([
    { from: 17, to: 31 },
    { from: 61, to: 90 },
  ]);
  expect(monthStarts("2026-10-15", 90)).toEqual([
    { offset: 17, date: "2026-11-01" },
    { offset: 47, date: "2026-12-01" },
    { offset: 78, date: "2027-01-01" },
  ]);
});
