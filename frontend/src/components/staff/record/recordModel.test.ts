import { describe, expect, test } from "vitest";
import type { Audit, Entitlement, MemberRequirements, Payment, Person } from "../../../lib/staffContracts";
import { activity, byDay, needs, phoneText, plans, requirements, verdict } from "./recordModel";

const NOW = new Date("2026-11-10T19:00:00Z");
const person = (over: Partial<Person> = {}): Person => ({
  id: 14,
  firstName: "Jordan",
  lastName: "Demo",
  email: "jordan@example.invalid",
  phone: "5855550142",
  status: "active",
  accessStatus: "active",
  accessReason: "",
  accountReason: "",
  conductFlag: false,
  address: {},
  contactPreferences: {},
  roles: ["member"],
  primaryRole: "member",
  revision: 7,
  ...over,
});
const req = (over: Partial<MemberRequirements> = {}): MemberRequirements => ({
  account: "active",
  access: "active",
  entitlement: { kind: "membership", name: "Monthly", endsAt: "2026-12-09T20:35:00Z" },
  waivers: { required: 1, signed: 1, missing: [], lastSignedAt: "2026-03-14T15:00:00Z" },
  training: { required: 4, held: 3, missing: ["Darth Vader"] },
  cards: { active: 1 },
  minor: null,
  visit: null,
  ...over,
});
const audit = (over: Partial<Audit>): Audit => ({
  id: String(Math.random()),
  actorId: 2,
  actorName: "Alex Demo",
  subjectId: 14,
  action: "user.profile_updated",
  entityType: "user",
  entityId: 14,
  createdAt: "2026-11-10T17:27:00Z",
  ...over,
});

describe("verdict", () => {
  test("cleared, but says which machines still need training", () => {
    const v = verdict({ person: person(), req: req(), supervision: null, audit: [], now: NOW });
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("Cleared for the shop");
    expect(v.detail).toMatch(/^Except Darth Vader, which needs training\./);
  });
  test("on hold quotes the reason and who set it", () => {
    const v = verdict({
      person: person({ status: "suspended", accountReason: "Payment dispute" }),
      req: req(),
      supervision: null,
      audit: [audit({ action: "user.account_suspended", createdAt: "2026-11-02T14:14:00Z" })],
      now: NOW,
    });
    expect(v).toMatchObject({ tone: "bad", icon: "pause", quote: "Payment dispute" });
    expect(v.title).toMatch(/On hold/);
    expect(v.detail).toMatch(/^Set by Alex Demo /);
  });
  test("facility suspension is its own verdict and keeps sign-in", () => {
    const v = verdict({ person: person({ accessStatus: "suspended", accessReason: "Unsafe use" }), req: req(), supervision: null, audit: [], now: NOW });
    expect(v.title).toBe("Facility access suspended");
    expect(v.detail).toMatch(/can still sign in/);
  });
  test("a minor in the building is told the cascade", () => {
    const v = verdict({
      person: person({ firstName: "Riley" }),
      req: req({ minor: { sponsorName: "Sam Chen", sponsorHere: true } }),
      supervision: { isMinor: true, marker: "Under 18", sponsor: { id: 5, name: "Sam Chen", revision: 1 }, sponsorEligible: true, visit: { id: 1, buildingId: 1, checkedInAt: "2026-11-10T21:10:00Z", sponsorId: 5 } },
      audit: [],
      now: NOW,
    });
    expect(v.tone).toBe("in");
    expect(v.detail).toBe("With Sam Chen, their sponsoring adult. Checking Sam out ends Riley’s visit too.");
  });
  test("what blocks check-in, in the order the desk checks it", () => {
    const base = { person: person(), supervision: null, audit: [], now: NOW };
    expect(verdict({ ...base, req: req({ entitlement: null }) }).title).toBe("No membership or day pass");
    expect(verdict({ ...base, req: req({ waivers: { required: 2, signed: 1, missing: ["Shop safety"], lastSignedAt: null } }) }).detail).toMatch(/sign Shop safety/);
    expect(verdict({ ...base, req: req({ minor: { sponsorName: null, sponsorHere: false } }) }).title).toBe("Needs a sponsoring adult");
    expect(verdict({ ...base, req: req({ minor: { sponsorName: "Sam Chen", sponsorHere: false } }) }).title).toBe("Waiting for Sam Chen");
  });
});

test("requirement tiles say each fact in a few words", () => {
  const tiles = requirements(person(), req());
  expect(tiles.map((t) => [t.label, t.state, t.value])).toEqual([
    ["Account", "ok", "Active"],
    ["Membership", "ok", "Monthly to Dec 9"],
    ["Waiver", "ok", "Signed Mar 14"],
    ["Training", "warn", "Not on Darth Vader"],
    ["NFC card", "ok", "1 active"],
  ]);
  const minor = requirements(person(), req({ minor: { sponsorName: "Sam Chen", sponsorHere: false }, cards: { active: 0 } }));
  expect(minor.find((t) => t.key === "sponsor")).toMatchObject({ state: "warn", value: "Sam isn’t here" });
  expect(minor.find((t) => t.key === "card")).toMatchObject({ state: "warn", value: "No card yet" });
  expect(requirements(person({ status: "suspended" }), req())[0]).toMatchObject({ state: "bad", value: "On hold" });
});

test("activity drops database echoes and names taps, visits and changes", () => {
  const rows = activity([
    audit({ action: "user.update", entityType: "user" }),
    audit({ action: "app_device_access_event.insert", entityType: "app_device_access_event", allowed: false, accessReason: "CERTIFICATION_REQUIRED", resourceName: "Darth Vader", actorName: "System" }),
    audit({ action: "visit.check-in", reason: "Checked in at the front desk" }),
    audit({ action: "user.conduct_flagged", reason: "Ignored shop rules" }),
    audit({ action: "entitlement.suspended", entityType: "membership" }),
  ]);
  expect(rows.map((r) => [r.type, r.title])).toEqual([
    ["tap", "Card tap denied at Darth Vader"],
    ["visit", "Checked in"],
    ["change", "Conduct flag turned on"],
    ["change", "Membership or pass set to suspended"],
  ]);
  expect(rows[0]!.detail).toBe("Required training is missing, revoked or expired.");
  expect(rows[2]!.detail).toBe("“Ignored shop rules” · by Alex Demo");
  expect(byDay(rows, NOW).map((g) => g.day)).toEqual(["Today"]);
});

test("needs lists only what a staff member can act on now", () => {
  const live: Entitlement = { id: 1, userId: 14, planId: 3, status: "active", effectiveStatus: "active", revision: 2, startsAt: "2026-11-08T20:35:00Z", endsAt: "2026-11-14T20:35:00Z", plan: { name: "Monthly" }, reason: "", cardBilled: false };
  const pending = { id: 12, status: "pending", amount: "95.00", planName: "Monthly", recordedAt: "2026-11-08T20:35:00Z" } as Payment;
  const items = needs({
    person: person(),
    req: req(),
    audit: [audit({ entityType: "app_device_access_event", action: "app_device_access_event.insert", allowed: false, accessReason: "CERTIFICATION_REQUIRED", resourceName: "Darth Vader" })],
    memberships: [live],
    payments: [pending],
    canManage: true,
    now: NOW,
  });
  expect(items.map((i) => i.title)).toEqual(["Denied at Darth Vader today", "Membership ends in 4 days", "$95.00 payment pending"]);
  expect(items[0]!.action).toMatchObject({ kind: "link", label: "Open training" });
  // A month away is not a task, and someone who can't manage the account gets no buttons for it.
  expect(needs({ person: person(), req: req(), audit: [], memberships: [{ ...live, endsAt: "2026-12-09T20:35:00Z" }], payments: [pending], canManage: false, now: NOW })).toEqual([]);
  const hold = needs({ person: person({ status: "suspended" }), req: req(), audit: [], memberships: [{ ...live, cardBilled: true }], payments: [], canManage: true, now: NOW });
  expect(hold[0]).toMatchObject({ id: "hold", action: { kind: "entitlement", label: "Suspend membership access" } });
  expect(hold[0]!.detail).toMatch(/keeps billing/);
  expect(hold[0]!.detail).toMatch(/does not pause or cancel card billing/);
});

test("current plan is the live one; everything else is earlier", () => {
  const m = (id: number, effectiveStatus: string, startsAt: string): Entitlement =>
    ({ id, effectiveStatus, status: effectiveStatus, startsAt, endsAt: startsAt, plan: { name: "Monthly" } }) as Entitlement;
  const out = plans([m(2, "active", "2026-11-08"), m(1, "expired", "2026-10-08")], [{ id: 9, effectiveStatus: "expired", status: "active", validDate: "2026-10-30" } as Entitlement]);
  expect(out.current?.id).toBe(2);
  expect(out.currentKind).toBe("membership");
  expect(out.earlier.map((e) => e.item.id)).toEqual([9, 1]);
});

test("phone numbers read grouped when they are plain digits", () => {
  expect(phoneText("5855550142")).toBe("(585) 555-0142");
  expect(phoneText("15855550142")).toBe("(585) 555-0142");
  expect(phoneText("+44 20 7946")).toBe("+44 20 7946");
});
