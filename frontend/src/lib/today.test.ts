import { expect, test } from "vitest";
import type { LiveEquipment, Reservation } from "./contracts";
import type { ComplianceReport } from "./staffContracts";
import type { Rental, Studio } from "./studioContracts";
import { dayKey, formatTime, localHour, equipmentBookings, timeWindow, shortName, initials, tone, blockKind, bookingBlock, machineStatus, groupMachines, studioOccupancy, studioPaymentsToRecord, needsYou } from "./today";
const zone = "Asia/Kolkata", day = "2026-10-28", now = Date.parse("2026-10-28T07:30:00Z");
const booking = (start = "2026-10-28T06:30:00Z", end = "2026-10-28T08:30:00Z"): Reservation => ({ id: 1, userId: 1, equipmentId: 1, equipmentName: "Lathe", startTime: start, endTime: end, location: "Shop", status: "confirmed", revision: 1, memberName: "Dana Whitfield" });
const machine = (id: number, type = "Wood", status = "available") => ({ id, name: `Machine ${id}`, type, status }) as LiveEquipment;
const compliance = (waivers: number, training: number) => ({ summary: { userCount: 5, waiverCompliantUsers: 5 - waivers, certificationCompliantUsers: 5 - training } }) as ComplianceReport;
test("configured calendar dates and wall hours are independent of host zone", () => {
  expect(dayKey(Date.parse("2026-10-27T23:00:00Z"), zone)).toBe(day);
  expect(localHour(day, 9, zone)).toBe(Date.parse("2026-10-28T03:30:00Z"));
  expect(formatTime(now, zone)).toBe("1:00 PM");
  expect(formatTime(now, zone, false)).toBe("1:00");
  expect(localHour("2026-11-01", 9, "America/New_York")).toBe(Date.parse("2026-11-01T14:00:00Z"));
});
test("window widens out to local whole hours and ticks every three hours", () => {
  const w = timeWindow(now, zone, [booking("2026-10-28T02:45:00Z", "2026-10-28T16:45:00Z")]);
  expect(formatTime(w.start, zone)).toBe("8:00 AM");
  expect(formatTime(w.end, zone)).toBe("11:00 PM");
  expect(w.windowHours).toBe(15);
  expect(w.ticks.map(t => t.label)).toEqual(["8 AM", "11 AM", "2 PM", "5 PM", "8 PM", "11 PM"]);
  expect(timeWindow(now, zone, []).ticks.map(t => t.label)).toEqual(["9 AM", "12 PM", "3 PM", "6 PM", "9 PM"]);
});
test("now fractions outside the window hide the marker", () => {
  const early = timeWindow(localHour(day, 8, zone), zone, []), late = timeWindow(localHour(day, 22, zone), zone, []);
  expect(early.nowFraction).toBeLessThan(0); expect(early.nowInsideWindow).toBe(false);
  expect(late.nowFraction).toBeGreaterThan(1); expect(late.nowInsideWindow).toBe(false);
  expect(timeWindow(now, zone, []).nowInsideWindow).toBe(true);
});
test("every block kind and precedence", () => {
  expect(blockKind(0, 1, 2, true, true, true)).toBe("past");
  expect(blockKind(0, 3, 2, true, true, true)).toBe("live");
  expect(blockKind(3, 4, 2, true, true, true)).toBe("conflict");
  expect(blockKind(3, 4, 2, false, false, true)).toBe("class");
  expect(blockKind(3, 4, 2, false, false)).toBe("booked");
});
test("blocks clip and retain full accessible times", () => {
  const w = { start: now, end: now + 1800000 };
  expect(bookingBlock(booking(), w, now, zone, true, false)).toMatchObject({ left: 0, width: 1, text: "Dana W.", label: "Dana Whitfield, 12:00 PM to 2:00 PM, in use now" });
  expect(bookingBlock(booking(), w, now, zone, false, true)?.label).toContain("affected by outage");
  expect(bookingBlock(booking(), { start: now + 7200000, end: now + 10800000 }, now, zone, false, false)).toBeNull();
});
test("status and phone copy for live, down, open, and no bookings", () => {
  expect(machineStatus([booking()], now, zone, true, false)).toEqual({ statusText: "In use until 2:00 PM", nextText: "Dana W. until 2:00" });
  expect(machineStatus([], now, zone, true, false).statusText).toBe("In use");
  expect(machineStatus([], now, zone, false, true).statusText).toBe("Out of service");
  expect(machineStatus([booking()], now - 7200000, zone, false, false)).toEqual({ statusText: "Open, next at 12:00 PM", nextText: "Next: Dana W. at 12:00" });
  expect(machineStatus([], now, zone, false, false)).toEqual({ statusText: "Open", nextText: "Nothing else booked today" });
});
test("equipment bookings exclude cancellations and rooms and sort stably", () => {
  expect(equipmentBookings([{ ...booking(), status: "cancelled" }, { ...booking(), equipmentId: null, resourceType: "room" }, booking()])).toEqual([booking()]);
  expect(groupMachines([machine(1), machine(2, "Metal"), machine(3)]).map(m => [m.id, m.lastOfType])).toEqual([[1, false], [3, true], [2, true]]);
});
test("needs you orders waiver, outages and training with correct pluralisation", () => {
  const items = needsYou(compliance(1, 2), [machine(1, "Wood", "unavailable")], [booking()], now);
  expect(items.map(i => i.icon)).toEqual(["waiver", "machine", "training"]);
  expect(items[0].title).toBe("1 member has no current waiver");
  expect(items[1].detail).toBe("1 booking today is affected.");
  expect(items[2].title).toBe("2 members need training renewed");
  const plural = needsYou(compliance(2, 1), [machine(1, "Wood", "maintenance")], [booking(), { ...booking(), id: 2 }], now);
  expect(plural[0].title).toBe("2 members have no current waiver"); expect(plural[1].detail).toBe("2 bookings today are affected."); expect(plural[2].title).toBe("1 member needs training renewed");
  expect(needsYou(compliance(0, 0), [machine(1, "Wood", "unavailable")], [], now)[0].detail).toBe("No bookings affected today.");
  expect(needsYou(compliance(0, 0), [], [], now)).toEqual([]);
});
test("studio occupancy uses end-exclusive dates and tells rented from held", () => {
  const studio = (id: number, availability: { starts_on: string; ends_on: string; status: string }[]) =>
    ({ id, name: `Studio ${id}`, size: "Small", availability: availability.map(a => ({ ...a, hold_until: "" })) }) as unknown as Studio;
  const rows = studioOccupancy([
    studio(1, [{ starts_on: "2026-10-01", ends_on: "2026-11-01", status: "confirmed" }]),
    studio(2, [{ starts_on: day, ends_on: "2026-10-29", status: "pending" }]),
    studio(3, [{ starts_on: "2026-10-01", ends_on: day, status: "confirmed" }]),
    studio(4, []),
  ], day);
  expect(rows.map(r => r.state)).toEqual(["rented", "held", "open", "open"]);
});
test("studio payments to record match the Studios page rule", () => {
  const rental = (status: string, payment_method: string, payment_status: string) => ({ status, payment_method, payment_status }) as Rental;
  expect(studioPaymentsToRecord([
    rental("pending", "manual", "unpaid"),
    rental("pending", "card", "unpaid"),
    rental("confirmed", "card", "refund_pending"),
    rental("confirmed", "card", "refund_failed"),
    rental("confirmed", "manual", "paid"),
  ])).toBe(3);
});
test("studio payments sit between waivers and outages in needs you", () => {
  const items = needsYou(compliance(1, 0), [machine(1, "Wood", "unavailable")], [], now, 2);
  expect(items.map(i => i.icon)).toEqual(["waiver", "payment", "machine"]);
  expect(items[1].title).toBe("2 studio payments to record");
  expect(needsYou(compliance(0, 0), [], [], now, 1)[0].title).toBe("1 studio payment to record");
});
test("the window never runs past the local day", () => {
  const late = { ...booking(), startTime: "2026-10-28T20:00:00Z", endTime: "2026-10-29T20:00:00Z" };
  const w = timeWindow(now, "Asia/Kolkata", [late]);
  expect(w.end).toBe(localHour(day, 24, "Asia/Kolkata"));
});
test("names and stable avatar tones", () => {
  expect(shortName("Dana Whitfield")).toBe("Dana W."); expect(shortName("Dana")).toBe("Dana");
  expect(initials(" Dana Whitfield ")).toBe("DW"); expect(initials("Dana")).toBe("D"); expect(initials("")).toBe("");
  expect(tone(31)).toBe(tone(31)); expect(tone(31)).toBe(1); expect(tone(-1)).toBe(4);
});
