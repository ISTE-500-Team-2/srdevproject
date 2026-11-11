import { expect, test } from "vitest";
import type { Reservation } from "./contracts";
import { canChange, dayLabel, isFree, lengthsFrom, reservationStatus, sameTimeOn, scheduleKind, slotAt, startSlots, timeRange } from "./reservationSchedule";

const zone = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const booking = (id: number, start: string, end: string, extra: Partial<Reservation> = {}): Reservation => ({
  id, userId: 1, equipmentId: 3, equipmentName: "Rachel", resourceType: "equipment", startTime: start, endTime: end,
  location: "Makerspace", status: "confirmed", revision: 1, ...extra,
});
// 3:00–4:00 PM Eastern on Nov 11, 2026.
const rachel = booking(1, "2026-11-11T20:00:00Z", "2026-11-11T21:00:00Z");

test("a slot must clear other bookings by the backend's 15-minute gap", () => {
  expect(isFree(at("2026-11-11T21:00:00Z"), at("2026-11-11T22:00:00Z"), [rachel])).toBe(false);
  expect(isFree(at("2026-11-11T21:15:00Z"), at("2026-11-11T22:15:00Z"), [rachel])).toBe(true);
  expect(isFree(at("2026-11-11T18:45:00Z"), at("2026-11-11T19:45:00Z"), [rachel])).toBe(true);
  expect(isFree(at("2026-11-11T19:00:00Z"), at("2026-11-11T19:50:00Z"), [rachel])).toBe(false);
  // Moving a booking ignores the booking itself, and cancelled bookings never block.
  expect(isFree(at("2026-11-11T20:30:00Z"), at("2026-11-11T21:30:00Z"), [rachel], 1)).toBe(true);
  expect(isFree(at("2026-11-11T20:00:00Z"), at("2026-11-11T21:00:00Z"), [{ ...rachel, status: "cancelled" }])).toBe(true);
});

test("start times skip the past and mark the ones an hour can't fit", () => {
  const now = at("2026-11-11T18:15:00Z"); // 1:15 PM
  const slots = startSlots("2026-11-11", zone, now, [rachel]);
  expect(slots[0].at).toBe(at("2026-11-11T18:30:00Z"));
  expect(slots.at(-1)!.at).toBe(at("2026-11-12T04:30:00Z")); // 11:30 PM
  const free = (iso: string) => slots.find((slot) => slot.at === at(iso))!.free;
  expect(free("2026-11-11T18:30:00Z")).toBe(true); // 1:30–2:30, clear of 3:00 by 30 min
  expect(free("2026-11-11T19:00:00Z")).toBe(false); // 2:00–3:00 touches 3:00
  expect(free("2026-11-11T21:00:00Z")).toBe(false); // 4:00 is inside the gap after 4:00
  expect(free("2026-11-11T21:30:00Z")).toBe(true);
});

test("lengths stop at the next booking's gap", () => {
  expect(lengthsFrom(at("2026-11-11T17:00:00Z"), [rachel])).toEqual([1, 2]);
  expect(lengthsFrom(at("2026-11-11T21:30:00Z"), [rachel])).toHaveLength(24);
});

test("blocks use Today's kinds and add the unpaid hold", () => {
  const now = at("2026-11-11T18:15:00Z");
  expect(scheduleKind(rachel, now, false, false)).toBe("booked");
  expect(scheduleKind({ ...rachel, status: "pending" }, now, false, false)).toBe("hold");
  expect(scheduleKind({ ...rachel, status: "pending" }, now, false, true)).toBe("conflict");
  expect(scheduleKind(rachel, at("2026-11-11T22:00:00Z"), false, false)).toBe("past");
  expect(scheduleKind(rachel, at("2026-11-11T20:30:00Z"), true, false)).toBe("live");
});

test("status words match the timeline", () => {
  const now = at("2026-11-11T18:15:00Z");
  expect(reservationStatus(rachel, now, false)).toEqual({ label: "Confirmed", tone: "ok" });
  expect(reservationStatus(rachel, now, true)).toEqual({ label: "Affected by outage", tone: "danger" });
  expect(reservationStatus({ ...rachel, status: "pending" }, now, false).label).toBe("Awaiting payment");
  expect(reservationStatus({ ...rachel, status: "cancelled" }, now, false).label).toBe("Cancelled");
  expect(reservationStatus(rachel, at("2026-11-12T00:00:00Z"), false).label).toBe("Completed");
});

test("bookings paid online, rooms and finished bookings can't be changed here", () => {
  const now = at("2026-11-11T18:15:00Z");
  expect(canChange(rachel, now)).toBe(true);
  expect(canChange({ ...rachel, payerId: 9 }, now)).toBe(false);
  expect(canChange({ ...rachel, resourceType: "room", equipmentId: null }, now)).toBe(false);
  expect(canChange(rachel, at("2026-11-12T00:00:00Z"))).toBe(false);
});

test("the timeline snaps a point to the half hour under it", () => {
  const window = { start: at("2026-11-11T14:00:00Z"), end: at("2026-11-12T02:00:00Z") }; // 9 AM–9 PM
  expect(slotAt(0, window)).toBe(window.start);
  expect(slotAt(0.5, window)).toBe(at("2026-11-11T20:00:00Z"));
  expect(slotAt(0.52, window)).toBe(at("2026-11-11T20:00:00Z"));
  expect(slotAt(1, window)).toBe(at("2026-11-12T01:30:00Z"));
});

test("days and times read the way the rest of the workspace writes them", () => {
  expect(dayLabel("2026-11-11", "2026-11-11")).toBe("Today, Wednesday, Nov 11");
  expect(dayLabel("2026-11-12", "2026-11-11")).toBe("Tomorrow, Thursday, Nov 12");
  expect(dayLabel("2026-11-13", "2026-11-11", "short")).toBe("Fri, Nov 13");
  expect(timeRange("2026-11-11T20:00:00Z", "2026-11-11T21:00:00Z", zone)).toBe("3:00–4:00 PM");
  expect(timeRange("2026-11-11T16:30:00Z", "2026-11-11T18:00:00Z", zone)).toBe("11:30 AM–1:00 PM");
  expect(timeRange("2026-11-27T04:00:00Z", "2026-11-27T05:00:00Z", zone)).toBe("11:00 PM–12:00 AM");
});

test("moving to another day keeps the clock time across daylight-saving changes", () => {
  // 9:00 AM EST on Mar 13, 2027 -> 9:00 AM EDT on Mar 14.
  expect(sameTimeOn(at("2027-03-13T14:00:00Z"), "2027-03-14", zone)).toBe(at("2027-03-14T13:00:00Z"));
  // 9:00 AM EDT on Oct 31, 2026 -> 9:00 AM EST on Nov 1.
  expect(sameTimeOn(at("2026-10-31T13:00:00Z"), "2026-11-01", zone)).toBe(at("2026-11-01T14:00:00Z"));
  expect(sameTimeOn(at("2026-11-11T20:30:00Z"), "2026-11-12", zone)).toBe(at("2026-11-12T20:30:00Z"));
});

test("a booking just after midnight limits a late start the evening before", () => {
  const midnight = booking(2, "2026-11-12T05:00:00Z", "2026-11-12T06:00:00Z"); // 12–1 AM on Nov 12
  expect(lengthsFrom(at("2026-11-12T03:00:00Z"), [midnight])).toEqual([1]); // 10 PM: 11 PM ends 1 h before midnight
  expect(lengthsFrom(at("2026-11-12T04:00:00Z"), [midnight])).toEqual([]); // 11 PM: an hour reaches midnight
});

test("a 24-hour booking across the spring change ends two calendar days later", () => {
  // 11:30 PM EST Mar 13, 2027 + 24 h = 12:30 AM EDT Mar 15, because Mar 14 has 23 hours.
  const midnight = booking(3, "2027-03-15T04:00:00Z", "2027-03-15T05:00:00Z");
  expect(lengthsFrom(at("2027-03-14T04:30:00Z"), [midnight])).toHaveLength(23);
});
