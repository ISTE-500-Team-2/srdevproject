// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MemberDetail, MemberRequirements } from "../../../lib/staffContracts";
import { MemberRecord } from "./MemberRecord";

const { api, reload, state, actor } = vi.hoisted(() => ({
  api: vi.fn(),
  reload: vi.fn(),
  actor: { id: 2, roles: ["admin"] as string[] },
  state: { detail: null as unknown as MemberDetail, req: null as unknown as MemberRequirements, supervision: null as unknown, cards: [] as unknown[] },
}));
vi.mock("../../../lib/api", () => ({
  api,
  ApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  errorMessage: (e: Error) => e.message,
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
                ? []
                : path.startsWith("/admin/users/")
                  ? state.detail
                  : null;
    return { data, loading: false, refreshing: false, error: "", reload };
  },
}));
vi.mock("../../../context/AuthContext", () => ({ useAuth: () => ({ user: actor }) }));

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
