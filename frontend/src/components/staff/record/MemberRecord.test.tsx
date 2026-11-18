// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MemberDetail, MemberRequirements } from "../../../lib/staffContracts";
import { MemberRecord } from "./MemberRecord";

const { api, reload, state, actor, tab } = vi.hoisted(() => ({
  api: vi.fn(),
  reload: vi.fn(),
  actor: { id: 2, roles: ["admin"] as string[] },
  /** A member's account opened from another tab: the sign-in shows them, with staff as the actor. */
  tab: { opened: null as null | { id: number; roles: string[] } },
  state: { detail: null as unknown as MemberDetail, req: null as unknown as MemberRequirements, supervision: null as unknown, cards: [] as unknown[], errors: {} as Record<string, string>, overrides: [] as unknown[] },
}));
vi.mock("../../../lib/api", () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  // Same rule as the real helper: only server errors keep their message.
  errorMessage: (e: Error) => (e?.constructor?.name === "ApiError" ? e.message : "Cannot reach the server. Please try again."),
}));
vi.mock("../../../lib/useApi", () => ({
  useApi: (path: string | null) => {
    const data =
      path === null
        ? null
        : path.endsWith("/requirements")
          ? state.req
          : path.endsWith("/supervision")
            ? state.supervision
            : path.startsWith("/admin/access/cards")
              ? state.cards
              : path.startsWith("/admin/access/overrides")
                ? state.overrides
                : path.startsWith("/admin/users/")
                  ? state.detail
                  : null;
    const kind = path?.endsWith("/requirements")
      ? "requirements"
      : path?.endsWith("/supervision")
        ? "supervision"
        : path?.startsWith("/admin/access/cards")
          ? "cards"
          : path?.startsWith("/admin/access/overrides")
            ? "overrides"
            : "detail";
    return { data, loading: false, refreshing: false, error: path === null ? "" : (state.errors[kind] ?? ""), reload };
  },
}));
vi.mock("../../../context/AuthContext", () => ({ useAuth: () => (tab.opened ? { user: tab.opened, actor } : { user: actor, actor: null }) }));

const user = (over: Partial<MemberDetail["user"]> = {}) => ({
  id: 14,
  firstName: "Casey",
  lastName: "Demo",
  email: "casey@example.invalid",
  phone: "5855550142",
  roles: ["member"],
  primaryRole: "member",
  status: "active",
  accessStatus: "active" as const,
  accessReason: "",
  accountReason: "",
  conductFlag: false,
  address: {},
  contactPreferences: {},
  revision: 7,
  ...over,
});
beforeEach(() => {
  actor.id = 2;
  actor.roles = ["admin"];
  tab.opened = null;
  state.detail = {
    user: user(),
    memberships: [],
    passes: [],
    payments: { items: [], nextOffset: null },
    audit: { items: [], nextOffset: null },
    checkIns: [],
  };
  state.req = {
    account: "active",
    access: "active",
    entitlement: { kind: "membership", name: "Monthly", endsAt: "2099-12-09T20:35:00Z" },
    waivers: { required: 1, signed: 1, missing: [], lastSignedAt: "2026-03-14T15:00:00Z" },
    training: { required: 1, held: 1, missing: [] },
    cards: { active: 0 },
    minor: null,
    visit: null,
  };
  state.supervision = { isMinor: false, marker: null, sponsor: null, visit: null };
  state.cards = [];
  state.errors = {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const mount = () =>
  render(
    <MemoryRouter>
      <MemberRecord id={14} name="Casey Demo" plans={[]} timeZone="America/New_York" onChanged={reload} onClose={() => {}} />
    </MemoryRouter>,
  );
const record = () => screen.getByRole("dialog", { name: "Casey Demo" });

test("the name is said once and the verdict leads with the desk action", async () => {
  api.mockResolvedValue({});
  mount();
  expect(within(record()).getAllByText("Casey Demo")).toHaveLength(2); // header, and the Name & phone fact
  expect(within(record()).getByRole("heading", { name: "Cleared for the shop" })).toBeTruthy();
  expect(screen.getAllByText("(585) 555-0142")).toHaveLength(2); // header contact line and the Name & phone fact
  fireEvent.click(screen.getByRole("button", { name: "Check in" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/admin/users/14/supervision/check-in", { method: "POST", body: {} }));
  expect(await screen.findByText("Casey checked in.")).toBeTruthy();
});

test("the cleared verdict sets the training gap apart from where the member is", () => {
  state.req = { ...state.req, training: { required: 3, held: 1, missing: ["CNC Machine", "Laser"] } };
  mount();
  const verdict = screen.getByRole("region", { name: "Cleared for the shop" });
  expect(within(verdict).getByText("Except CNC Machine and Laser, which need training.")).toBeTruthy();
  expect(within(verdict).getByText("Not in the building").closest(".mr-lead__facts")).toBeTruthy();
  // The check-in button still reads out both parts.
  expect(screen.getByRole("button", { name: "Check in" }).getAttribute("aria-describedby")).toBe("mr-verdict-detail mr-verdict-facts");
});

test("check-in is held back with the reason when something blocks it", () => {
  state.req = { ...state.req, entitlement: null };
  mount();
  const checkIn = screen.getByRole("button", { name: "Check in" }) as HTMLButtonElement;
  expect(checkIn.disabled).toBe(true);
  expect(checkIn.title).toBe("No membership or day pass");
});

test("a second status save uses the committed revision before the refresh lands", async () => {
  state.detail = { ...state.detail, user: user({ status: "suspended", accountReason: "Payment dispute" }) };
  mount();
  expect(screen.getByText("Payment dispute")).toBeTruthy();
  api.mockResolvedValueOnce(user({ status: "active", revision: 8 }));
  fireEvent.click(screen.getByRole("button", { name: "Lift hold" }));
  let dialog = screen.getByRole("dialog", { name: "Lift the hold" });
  expect((within(dialog).getByRole("radio", { name: /^Active/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Dispute settled" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/status", { method: "POST", body: { status: "active", reason: "Dispute settled", revision: 7 } }),
  );
  expect(await screen.findByText("Casey can sign in and check in again.")).toBeTruthy();
  api.mockResolvedValueOnce(user({ status: "suspended", revision: 9 }));
  fireEvent.click(screen.getByRole("button", { name: "Change account status" }));
  dialog = screen.getByRole("dialog", { name: "Account status" });
  fireEvent.click(within(dialog).getByRole("radio", { name: /^On hold/ }));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Second change" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith("/admin/users/14/status", { method: "POST", body: { status: "suspended", reason: "Second change", revision: 8 } }),
  );
});

test("name and phone save with a blank phone and no note", async () => {
  api.mockResolvedValue(user({ phone: "", revision: 8 }));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Edit name & phone" }));
  const dialog = screen.getByRole("dialog", { name: "Name & phone" });
  fireEvent.change(within(dialog).getByLabelText(/^Phone/), { target: { value: "" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/profile", {
      method: "PATCH",
      body: { firstName: "Casey", lastName: "Demo", phone: "", reason: undefined, revision: 7 },
    }),
  );
});

test("suspending card membership access never promises to pause billing", async () => {
  api.mockResolvedValue({});
  state.detail.user = user({ status: "suspended" });
  state.detail.memberships = [{
    id: 1, userId: 14, planId: 3, status: "active", effectiveStatus: "active", revision: 2,
    startsAt: "2026-11-08T20:35:00Z", endsAt: "2099-12-09T20:35:00Z",
    plan: { name: "Monthly" }, reason: "", cardBilled: true,
  }];
  mount();
  expect(screen.getByRole("button", { name: "Change membership access" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Suspend membership access" }));
  const dialog = screen.getByRole("dialog", { name: "Monthly #1" });
  expect(within(dialog).getByText(/does not pause or cancel card billing/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("radio", { name: /^Suspend access/ }));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Account on hold" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/admin/users/14/entitlements/membership/1/status", {
    method: "POST", body: { status: "suspended", revision: 2, reason: "Account on hold" },
  }));
  expect(await screen.findByText("The membership access is suspended. Card billing is unchanged.")).toBeTruthy();
});

test("conduct flag is set from the record with a reason", async () => {
  api.mockResolvedValue(user({ conductFlag: true, revision: 8 }));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Change conduct flag" }));
  const dialog = screen.getByRole("dialog", { name: "Conduct flag" });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Ignored shop rules twice" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/conduct", {
      method: "POST",
      body: { flagged: true, reason: "Ignored shop rules twice", revision: 7 },
    }),
  );
});

test("roles: primary is chosen among the checked roles, student is separate", async () => {
  api.mockResolvedValue(user({ roles: ["instructor", "member"], primaryRole: "instructor", revision: 8 }));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Change roles" }));
  const dialog = screen.getByRole("dialog", { name: "Roles" });
  const primary = (name: string) => within(dialog).getByRole("radio", { name: `Make ${name} the primary role` }) as HTMLInputElement;
  expect(primary("Instructor").disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Instructor" }));
  expect(primary("Instructor").disabled).toBe(false);
  fireEvent.click(primary("Instructor"));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Teaching lathe classes" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/role", {
      method: "POST",
      body: { primaryRole: "instructor", roles: ["member", "instructor"], isStudent: false, reason: "Teaching lathe classes", revision: 7 },
    }),
  );
});

test("your own record locks what another administrator must change, and says why", () => {
  actor.id = 14;
  mount();
  // Your own record still gets the real verdict; the note says what you can change.
  expect(screen.getByRole("heading", { name: "Cleared for the shop" })).toBeTruthy();
  expect(screen.getByText(/^This is your account\./)).toBeTruthy();
  expect(screen.getByText("You can’t change your own status.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change account status" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit name & phone" })).toBeTruthy();
});

test("non-admin staff opening a staff account see it, but no controls", () => {
  actor.roles = ["staff"];
  state.detail = { ...state.detail, user: user({ roles: ["staff"], primaryRole: "staff" }) };
  mount();
  expect(screen.getAllByText("Only an administrator can change staff accounts.").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Sell or record/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Change / })).toBeNull();
});

test("a member's account opened in another tab doesn't take away an administrator's controls", () => {
  tab.opened = { id: 40, roles: ["member"] };
  state.detail = { ...state.detail, user: user({ roles: ["staff"], primaryRole: "staff" }) };
  mount();
  expect(screen.queryByText("Only an administrator can change staff accounts.")).toBeNull();
  expect(screen.getByRole("button", { name: "Change roles" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change account status" })).toBeTruthy();
});

test("a cancelled day pass can't be switched back on", () => {
  state.detail = {
    ...state.detail,
    passes: [
      { id: 8, userId: 14, planId: 2, status: "cancelled", effectiveStatus: "cancelled", revision: 2, validDate: "2099-01-08", plan: { name: "Day pass" }, reason: "" },
      { id: 9, userId: 14, planId: 2, status: "suspended", effectiveStatus: "suspended", revision: 1, validDate: "2099-01-09", plan: { name: "Day pass" }, reason: "" },
    ],
  };
  mount();
  expect(screen.getByText("Cancelled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change Day pass #8" })).toBeNull();
  // The suspended pass is the current one and keeps its control.
  expect(screen.getByRole("button", { name: "Change status" })).toBeTruthy();
});

test("ending card membership access that still renews shows why it was refused", async () => {
  const { ApiError } = await import("../../../lib/api");
  state.detail.memberships = [{
    id: 1, userId: 14, planId: 3, status: "active", effectiveStatus: "active", revision: 2,
    startsAt: "2026-11-08T20:35:00Z", endsAt: "2099-12-09T20:35:00Z",
    plan: { name: "Monthly" }, reason: "", cardBilled: true, renewing: true,
  }];
  mount();
  api.mockRejectedValueOnce(new ApiError(409, "CARD_RENEWAL_ACTIVE", "This membership still renews by card."));
  fireEvent.click(screen.getByRole("button", { name: "Change membership access" }));
  const dialog = screen.getByRole("dialog", { name: "Monthly #1" });
  // The step is on this record, not in View as (which can't open an account on hold or restricted).
  expect(within(dialog).getByText(/first choose Stop auto-renew on this membership/)).toBeTruthy();
  expect(within(dialog).queryByText(/View as/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("radio", { name: /^End access now/ }));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Banned" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "This membership still renews by card.");
  // Not a conflict: nothing changed, so the save stays available.
  expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

test("staff stop card renewal from the record while the member is on hold and restricted", async () => {
  state.detail.user = user({ status: "suspended", accessStatus: "suspended" });
  state.detail.memberships = [{
    id: 1, userId: 14, planId: 3, status: "active", effectiveStatus: "active", revision: 2,
    startsAt: "2026-11-08T20:35:00Z", endsAt: "2099-12-09T20:35:00Z",
    plan: { name: "Monthly" }, reason: "", cardBilled: true, renewing: true,
  }];
  api.mockResolvedValueOnce({ renewing: false, renewalEndsAt: "2099-12-09T20:35:00Z" });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  const dialog = screen.getByRole("dialog", { name: "Stop auto-renew for Monthly?" });
  expect(within(dialog).getByText(/doesn’t change access/)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Banned" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/memberships/1/stop-renewal", { method: "POST", body: { reason: "Banned" } }),
  );
  expect(await screen.findByText(/^Auto-renew is off\. Casey’s card billing ends Dec/)).toBeTruthy();
});

test("a stopped card renewal says so and offers no second stop", () => {
  state.detail.memberships = [{
    id: 1, userId: 14, planId: 3, status: "active", effectiveStatus: "active", revision: 2,
    startsAt: "2026-11-08T20:35:00Z", endsAt: "2099-12-09T20:35:00Z",
    plan: { name: "Monthly" }, reason: "", cardBilled: true, renewing: false, renewalEndsAt: "2099-12-09T20:35:00Z",
  }];
  mount();
  expect(screen.getByText(/^Auto-renew is off; card billing ends Dec/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Stop auto-renew/ })).toBeNull();
});

test("a card membership whose access ended but still charges is flagged with the way to stop it", () => {
  state.detail.memberships = [{
    id: 5, userId: 14, planId: 3, status: "revoked", effectiveStatus: "revoked", revision: 3,
    startsAt: "2026-11-08T20:35:00Z", endsAt: "2099-12-09T20:35:00Z",
    plan: { name: "Monthly" }, reason: "Banned", cardBilled: true, renewing: true,
  }];
  mount();
  expect(screen.getByText("Card still charged after access ended")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop auto-renew for Monthly #5" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  expect(screen.getByRole("dialog", { name: "Stop auto-renew for Monthly?" })).toBeTruthy();
});

test("a booking payment still in online checkout says why it has no desk action", () => {
  state.detail.payments = {
    items: [{
      id: 31, userId: 14, memberName: "Casey Demo", membershipId: null, dayPassId: null, amount: "40.00", status: "pending",
      method: "unspecified", reference: "", revision: 1, recordedAt: "2026-11-08T20:35:00Z", updatedAt: "2026-11-08T20:35:00Z",
      planName: "Equipment: Laser", onlineCheckout: true,
    }],
    nextOffset: null,
  };
  mount();
  expect(screen.getByText(/Paid by card online: the member pays through checkout, or cancel the reservation\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update payment #31" })).toBeNull();
  // Nothing for the desk to settle, so it isn't listed as needing staff either.
  expect(screen.queryByText("$40.00 payment pending")).toBeNull();
});

test("a minor shows the sponsor and the tag; check-in waits for the adult", () => {
  state.supervision = { isMinor: true, marker: "Under 18", sponsor: { id: 5, name: "Sam Chen", revision: 2 }, visit: null };
  state.req = { ...state.req, minor: { sponsorName: "Sam Chen", sponsorHere: false } };
  mount();
  expect(screen.getByText("Under 18")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Waiting for Sam Chen" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Check in" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole("region", { name: "Sponsoring adult" })).getByText("Not checked in")).toBeTruthy();
});

test("a card changed by someone else reloads the record and won't retry on the old revision", async () => {
  const { ApiError } = await import("../../../lib/api");
  state.cards = [{ id: 31, label: "Blue key card", active: true, revision: 4, last4: "4F21", assignedAt: "2026-10-02T19:40:00Z", assignedBy: "Alex Demo", lastUsedAt: null, lastReader: null }];
  mount();
  api.mockRejectedValueOnce(new ApiError(409, "STALE_RECORD", "Card changed"));
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  const dialog = screen.getByRole("dialog", { name: "Revoke Blue key card?" });
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Lost card" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/This card changed since you opened it/));
  expect(reload).toHaveBeenCalled();
  expect((within(dialog).getByRole("button", { name: "Revoke card" }) as HTMLButtonElement).disabled).toBe(true);
});

test("every earlier membership or pass can be reached, not just the first five", () => {
  const pass = (id: number) => ({ id, userId: 14, planId: 2, status: "active", effectiveStatus: "scheduled", revision: 1, validDate: `2099-01-0${id}`, plan: { name: "Day pass" }, reason: "" });
  // One upcoming pass is shown as the current plan; the other six are listed under Earlier.
  state.detail = { ...state.detail, passes: [1, 2, 3, 4, 5, 6, 7].map(pass) };
  mount();
  expect(screen.getAllByRole("button", { name: /^Change Day pass #/ })).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: /Show all 6/ }));
  expect(screen.getAllByRole("button", { name: /^Change Day pass #/ })).toHaveLength(6);
});

test("a status save that lost a race says so, and the next save uses the fresh revision", async () => {
  const { ApiError } = await import("../../../lib/api");
  mount();
  api.mockRejectedValueOnce(new ApiError(409, "STALE_RECORD", "Stale"));
  fireEvent.click(screen.getByRole("button", { name: "Change account status" }));
  const dialog = screen.getByRole("dialog", { name: "Account status" });
  fireEvent.click(within(dialog).getByRole("radio", { name: /^On hold/ }));
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Investigation" } });
  fireEvent.submit(within(dialog).getByRole("form"));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/^Someone else changed this account just now/));
  expect(reload).toHaveBeenCalled();
  expect((within(dialog).getByRole("button", { name: "Save status" }) as HTMLButtonElement).disabled).toBe(false);
});

test("a failed refresh of any record part keeps the record and says it may be out of date", () => {
  for (const kind of ["detail", "requirements", "supervision", "overrides"]) {
    state.errors = { [kind]: `${kind} request failed` };
    mount();
    const verdict = screen.getByRole("region", { name: "Cleared for the shop" });
    const stale = within(verdict).getByRole("status");
    expect(stale.textContent).toContain("Part of this record could not be refreshed, so it may be out of date.");
    expect(stale.textContent).toContain(`${kind} request failed`);
    // The record and its verdict stay as they were.
    expect(within(verdict).getByRole("button", { name: "Check in" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Requirements" })).toBeTruthy();
    cleanup();
  }
});

test("Reload re-reads only the parts that failed", () => {
  state.errors = { requirements: "Requirements request failed", overrides: "Overrides request failed" };
  mount();
  const stale = within(screen.getByRole("region", { name: "Cleared for the shop" })).getByRole("status");
  expect(stale.textContent).toContain("Requirements request failed");
  fireEvent.click(within(stale).getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalledTimes(2);
});

test("a fresh record shows no stale notice, and a card error stays with the cards", () => {
  mount();
  expect(within(screen.getByRole("region", { name: "Cleared for the shop" })).queryByRole("status")).toBeNull();
  cleanup();
  state.errors = { cards: "Cards request failed" };
  mount();
  expect(screen.queryByText(/could not be refreshed/)).toBeNull();
  expect(screen.getByText("Cards request failed")).toBeTruthy();
});

test("a record that never loaded shows its own error, not the stale notice", () => {
  state.detail = null as unknown as MemberDetail;
  state.errors = { detail: "Detail request failed" };
  mount();
  expect(screen.getByRole("alert").textContent).toContain("Detail request failed");
  expect(screen.queryByText(/could not be refreshed/)).toBeNull();
});

test("the notice stays while a retry is in flight and clears once a read succeeds", () => {
  const element = () => (
    <MemoryRouter>
      <MemberRecord id={14} name="Casey Demo" plans={[]} timeZone="America/New_York" onChanged={reload} onClose={() => {}} />
    </MemoryRouter>
  );
  state.errors = { requirements: "Requirements request failed" };
  const view = render(element());
  expect(screen.getByText(/could not be refreshed/)).toBeTruthy();
  // A retry clears the error at once while the older requirements stay on screen.
  state.errors = {};
  view.rerender(element());
  expect(screen.getByText(/could not be refreshed/).textContent).toContain("Requirements request failed");
  // A successful read brings new data, which ends the failure.
  state.req = { ...state.req };
  view.rerender(element());
  expect(screen.queryByText(/could not be refreshed/)).toBeNull();
});

test("staff see the member's photo and can remove it with a reason", async () => {
  state.detail = { ...state.detail, user: { ...user(), photoVersion: "v1" } };
  api.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith("/admin/photos") ? { 14: { version: "v1", image: "data:image/webp;base64,UEhPVE8=" } } : { version: null }),
  );
  mount();
  await waitFor(() => expect(record().querySelector(".mr-avatar img")?.getAttribute("src")).toBe("data:image/webp;base64,UEhPVE8="));
  expect(api).toHaveBeenCalledWith("/admin/photos?ids=14");
  expect(within(record()).getByText("Added by the member")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove profile photo" }));
  const dialog = screen.getByRole("dialog", { name: "Remove profile photo" });
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Not a photo of Casey" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove photo" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/14/photo", { method: "DELETE", body: { version: "v1", reason: "Not a photo of Casey" } }),
  );
  expect(await screen.findByText("Photo removed.")).toBeTruthy();
  expect(reload).toHaveBeenCalled();
});

test("without a photo, the record says members add their own", () => {
  mount();
  expect(within(record()).getByText("None")).toBeTruthy();
  expect(within(record()).getByText("Members add their own photo.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove profile photo" })).toBeNull();
});
