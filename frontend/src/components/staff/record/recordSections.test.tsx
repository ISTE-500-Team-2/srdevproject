// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NfcCard } from "../../../lib/nfc";
import type { MemberRequirements, Person } from "../../../lib/staffContracts";
import { RecordCards } from "./RecordCards";
import { RecordSupervision } from "./RecordSupervision";
import { DeskAction, RequirementList } from "./RecordVerdict";

afterEach(cleanup);

const person = (over: Partial<Person> = {}) =>
  ({
    id: 14,
    firstName: "Casey",
    lastName: "Demo",
    email: "casey@example.invalid",
    phone: "",
    roles: ["member"],
    primaryRole: "member",
    status: "active",
    accessStatus: "active",
    accessReason: "",
    accountReason: "",
    conductFlag: false,
    revision: 7,
    ...over,
  }) as Person;
const card = (over: Partial<NfcCard>): NfcCard =>
  ({ id: 1, label: "Blue key card", active: true, revision: 1, last4: "4F21", assignedAt: "2026-10-02T19:40:00Z", assignedBy: "Alex", lastUsedAt: null, lastReader: null, ...over }) as NfcCard;

test("the desk action checks out first, then lifts a hold, then restores access, then checks in", () => {
  const props = { blockedBy: "", canManage: true, self: false, busy: false, open: vi.fn(), visitAction: vi.fn() };
  const { rerender } = render(<DeskAction {...props} person={person({ status: "suspended" })} inBuilding />);
  fireEvent.click(screen.getByRole("button", { name: "Check out" }));
  expect(props.visitAction).toHaveBeenCalledWith("check-out");
  rerender(<DeskAction {...props} person={person({ status: "suspended", accessStatus: "suspended" })} inBuilding={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Lift hold" }));
  expect(props.open).toHaveBeenLastCalledWith({ kind: "status", lift: true });
  rerender(<DeskAction {...props} person={person({ accessStatus: "suspended" })} inBuilding={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Restore access" }));
  expect(props.open).toHaveBeenLastCalledWith({ kind: "access", restore: true });
  rerender(<DeskAction {...props} person={person()} inBuilding={false} blockedBy="No membership or day pass" />);
  const checkIn = screen.getByRole("button", { name: "Check in" }) as HTMLButtonElement;
  expect(checkIn.disabled).toBe(true);
  expect(checkIn.title).toBe("No membership or day pass");
  rerender(<DeskAction {...props} person={person()} inBuilding={false} canManage={false} />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("a requirement handled elsewhere opens that page; one on the record scrolls to its section", () => {
  const go = vi.fn();
  const req = {
    account: "active",
    access: "active",
    entitlement: null,
    waivers: { required: 1, signed: 0, missing: ["Shop waiver"], lastSignedAt: null },
    training: { required: 0, held: 0, missing: [] },
    cards: { active: 0 },
    minor: null,
    visit: null,
  } as unknown as MemberRequirements;
  const section = document.createElement("section");
  section.id = "mr-plan-14";
  section.scrollIntoView = vi.fn();
  document.body.append(section);
  render(<RequirementList person={person()} req={req} go={go} />);
  fireEvent.click(screen.getByRole("button", { name: /^Waiver/ }));
  expect(go).toHaveBeenCalledWith("/admin/certifications?section=compliance");
  fireEvent.click(screen.getByRole("button", { name: /^Membership or pass/ }));
  expect(section.scrollIntoView).toHaveBeenCalled();
  expect(section.classList.contains("mr-flash")).toBe(true);
  section.remove();
});

test("cards: the most recently used active card leads, and is shown blocked while access is held", () => {
  const cards = [
    card({ id: 1, label: "Old card", lastUsedAt: "2026-10-01T12:00:00Z" }),
    card({ id: 2, label: "New card", lastUsedAt: "2026-11-01T12:00:00Z" }),
    card({ id: 3, label: "Lost card", active: false }),
  ];
  render(<RecordCards person={person({ accessStatus: "suspended" })} cards={cards} error="" canManage open={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "NFC cards" })).toBeTruthy();
  expect(screen.getByRole("img", { name: /^New card, card ending 4F21, refused while the account is blocked$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke Old card" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reactivate Lost card" })).toBeTruthy();
});

test("cards: loading, then none yet", () => {
  const { rerender } = render(<RecordCards person={person()} cards={null} error="" canManage open={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Loading cards…");
  rerender(<RecordCards person={person()} cards={[]} error="" canManage open={vi.fn()} />);
  expect(screen.getByText("No card yet")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Assign a card" })).toBeTruthy();
});

test("supervised use lists only unlocks that are neither ended nor revoked", () => {
  const soon = new Date(Date.now() + 15 * 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const overrides = [
    { id: 1, kind: "equipment", resourceName: "Lathe", endsAt: soon, reason: "Watching", revokedAt: null },
    { id: 2, kind: "equipment", resourceName: "Saw", endsAt: past, reason: "Earlier", revokedAt: null },
    { id: 3, kind: "room", resourceName: "Paint room", endsAt: soon, reason: "Ended", revokedAt: past },
  ];
  const open = vi.fn();
  render(<RecordSupervision person={person()} overrides={overrides} canManage open={open} />);
  expect(screen.getByText("Lathe")).toBeTruthy();
  expect(screen.queryByText("Saw")).toBeNull();
  expect(screen.queryByText("Paint room")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "End" }));
  expect(open).toHaveBeenCalledWith({ kind: "endSupervision", override: overrides[0] });
});
