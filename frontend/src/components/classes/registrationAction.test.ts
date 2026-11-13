import { expect, test } from "vitest";
import type { ClassRecord } from "./classData";
import { registrationAction, sponsorReason, type Eligibility } from "./registrationAction";

const course: ClassRecord = {
  id: 5,
  title: "Safety 5",
  certificationId: 3,
  certificationName: "Laser",
  trainingFeeCents: 2000,
  instructorId: 1,
  instructor: "Instructor",
  capacity: 4,
  enrolled: 1,
  status: "scheduled",
  revision: 1,
  roomId: 1,
  roomName: "Room",
  startsAt: "2099-01-01T15:00:00Z",
  endsAt: "2099-01-01T16:00:00Z",
  myStatus: null,
};
const decide = (over: Partial<ClassRecord> = {}, eligibility: Eligibility = "eligible", extra: Partial<Parameters<typeof registrationAction>[0]> = {}) =>
  registrationAction({ c: { ...course, ...over }, eligibility, certified: false, busy: false, ...extra });

test("a registered member is registered, whatever else is true", () => {
  expect(decide({ myStatus: "enrolled", enrolled: 4 }, "ineligible")).toEqual({ kind: "registered" });
});

test("a full class is full before eligibility, and keeps the sponsor problem for the view to explain", () => {
  expect(decide({ enrolled: 4 }, "ineligible")).toEqual({ kind: "full", blocked: null });
  expect(decide({ enrolled: 4 }, "no-sponsor")).toEqual({ kind: "full", blocked: sponsorReason("no-sponsor") });
  // The view's fresher seat counts win over the class record's.
  expect(decide({}, "eligible", { seats: { capacity: 4, enrolled: 4 } }).kind).toBe("full");
  expect(decide({ enrolled: 4 }, "eligible", { seats: { capacity: 4, enrolled: 3 } }).kind).toBe("register");
});

test("a member without a membership or day pass is sent for one", () => {
  expect(decide({}, "ineligible")).toEqual({ kind: "needs-pass", blocked: null });
});

test("register is offered, and off while busy, unpriced or blocked by a sponsor problem", () => {
  expect(decide()).toEqual({ kind: "register", blocked: null, again: false, disabled: false });
  expect(decide({ myStatus: "cancelled" })).toMatchObject({ kind: "register", again: true, disabled: false });
  expect(decide({}, "eligible", { busy: true })).toMatchObject({ kind: "register", disabled: true });
  expect(decide({ trainingFeeCents: null })).toMatchObject({ kind: "register", disabled: true });
  // Holding the certification covers an unpriced training fee.
  expect(decide({ trainingFeeCents: null }, "eligible", { certified: true })).toMatchObject({ kind: "register", disabled: false });
  for (const eligibility of ["no-sponsor", "sponsor-inactive", "sponsor-unknown"] as const)
    expect(decide({}, eligibility)).toEqual({ kind: "register", blocked: sponsorReason(eligibility), again: false, disabled: true });
  // Still deciding eligibility: register stays available, as before.
  expect(decide({}, "unknown")).toMatchObject({ kind: "register", blocked: null, disabled: false });
});
