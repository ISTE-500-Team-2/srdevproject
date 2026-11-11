import { expect, test } from "vitest";
import { durationLabel, historyRows, readerLabel, totalDown, type ServiceNotice } from "./serviceNotices";

const notice = (over: Partial<ServiceNotice>): ServiceNotice => ({
  id: 1, source: "reader", readerId: "r1", summary: "Shop door has stopped reporting in.", openedAt: "2026-11-05T15:00:00Z",
  resolvedAt: "2026-11-05T15:05:00Z", recipients: null, resolution: null, openedBy: null, resolvedBy: null,
  readerName: "Shop door", readerLastSeenAt: null, recentDrops: null, ...over,
});

test("durations read the way staff say them", () => {
  expect(durationLabel(20_000)).toBe("<1 min");
  expect(durationLabel(42 * 60_000)).toBe("42 min");
  expect(durationLabel(125 * 60_000)).toBe("2 h 05 min");
  expect(durationLabel(120 * 60_000)).toBe("2 h");
  expect(durationLabel(28 * 3_600_000)).toBe("1 day 4 h");
  expect(durationLabel(-5)).toBe("<1 min");
});

test("a removed reader is still named from its notice", () => {
  expect(readerLabel(notice({ readerName: null }))).toBe("Shop door");
});

test("one reader's drops on the same facility day share a row; other readers, days and announcements split it", () => {
  const rows = historyRows(
    [
      notice({ id: 6, openedAt: "2026-11-06T04:30:00Z" }), // 11:30 PM Nov 5 in New York
      notice({ id: 5, openedAt: "2026-11-05T15:00:00Z" }),
      notice({ id: 4, openedAt: "2026-11-05T14:00:00Z", readerId: "r2", readerName: "Laser" }),
      notice({ id: 3, openedAt: "2026-11-05T13:00:00Z" }),
      notice({ id: 2, openedAt: "2026-11-04T13:00:00Z" }),
      notice({ id: 1, source: "staff", readerId: null, openedAt: "2026-11-04T12:00:00Z" }),
    ],
    "America/New_York",
  );
  expect(rows.map((row) => (row.kind === "reader" ? row.drops.map((d) => d.id) : `staff ${row.notice.id}`))).toEqual([
    [6, 5],
    [4],
    [3],
    [2],
    "staff 1",
  ]);
});

test("a group's downtime adds up every drop", () => {
  expect(totalDown([notice({}), notice({ resolvedAt: "2026-11-05T15:10:00Z" })])).toBe(15 * 60_000);
});
