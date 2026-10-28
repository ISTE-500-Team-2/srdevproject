// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import type { User } from "../../lib/contracts";

type Auth = {
  user: User | null;
  actor: User | null;
  openAccount: ReturnType<typeof vi.fn>;
  closeAccount: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};
const auth: Auth = {
  user: null,
  actor: null,
  openAccount: vi.fn(),
  closeAccount: vi.fn(),
  logout: vi.fn(),
};
vi.mock("../../context/AuthContext", () => ({ useAuth: () => auth }));

const responses = new Map<string, unknown>();
vi.mock("../../lib/useApi", () => ({
  useApi: (path: string | null) => ({
    data: path ? (responses.get(path.split("?")[0]) ?? null) : null,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));
const api = vi.fn();
vi.mock("../../lib/api", () => ({ api: (...args: unknown[]) => api(...args), errorMessage: (e: Error) => e.message }));
// The Today page has its own tests; keep this file about the shell and account mode.
vi.mock("../../pages/admin/TodayPage", () => ({ TodayPage: () => <h1>Today page</h1> }));

import { HomeRoute } from "../../App";
import { AccountBar } from "./AccountBar";
import { AccountPicker } from "./AccountPicker";
import { AdminShell } from "./AdminShell";
import { AccountHomePage } from "../../pages/AccountHomePage";

const person = (id: number, firstName: string, roles: string[]): User => ({
  id,
  firstName,
  lastName: "Tester",
  email: `${firstName.toLowerCase()}@example.invalid`,
  phone: "",
  role: roles.includes("admin") ? "admin" : roles.includes("staff") ? "staff" : "member",
  roles,
  membership: "None",
});
const admin = person(1, "Maximus", ["admin"]);
const staff = person(2, "Sam", ["staff"]);
const dana = person(7, "Dana", ["member"]);

function Where() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname + location.search}</output>;
}
const at = (element: React.ReactNode, path = "/") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{element}<Where /></>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  auth.user = null;
  auth.actor = null;
  auth.openAccount.mockReset().mockResolvedValue(undefined);
  auth.closeAccount.mockReset().mockResolvedValue(undefined);
  api.mockReset().mockResolvedValue({});
  responses.clear();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

test("staff land in the workspace; members get their home; an open account gets the action screen", () => {
  auth.user = admin;
  at(<HomeRoute />);
  expect(screen.getByLabelText("location").textContent).toBe("/admin");
  cleanup();

  auth.user = dana;
  auth.actor = admin;
  responses.set("/me/overview", { entitlement: { membership: true, dayPass: false }, pendingWaivers: 0, activeReservations: 0, canCheckIn: true, reasons: [], recentCheckIns: [] });
  at(<HomeRoute />);
  expect(screen.getByRole("heading", { name: "What would you like to do?" })).toBeTruthy();
});

test("the account bar names the member and the staff role, and goes back to the last workspace page", async () => {
  auth.user = dana;
  auth.actor = staff;
  sessionStorage.setItem("collaboratory.lastWorkspacePath", "/admin/members?search=dan");
  at(<AccountBar />);
  const bar = screen.getByRole("region", { name: "Account you are working in" });
  expect(bar.textContent).toContain("Dana Tester's");
  expect(within(bar).getByText("Staff")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
  await waitFor(() => expect(screen.getByLabelText("location").textContent).toBe("/admin/members?search=dan"));
  expect(auth.closeAccount).toHaveBeenCalledOnce();
});

test("the account bar is hidden outside account mode", () => {
  auth.user = admin;
  at(<AccountBar />);
  expect(screen.queryByRole("region", { name: "Account you are working in" })).toBeNull();
});

test("the picker opens your own account or a member's, and refuses staff accounts", async () => {
  auth.user = admin;
  responses.set("/admin/users", {
    items: [
      { ...dana, status: "active", accessStatus: "active" },
      { ...staff, status: "active", accessStatus: "active" },
      { ...person(9, "Ken", ["member"]), status: "suspended", accessStatus: "active" },
    ],
    nextOffset: null,
  });
  const onClose = vi.fn();
  at(<AccountPicker onClose={onClose} />);
  expect(screen.getByRole("button", { name: /Your own account/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search members by name or email" }), { target: { value: "da" } });
  await screen.findByRole("button", { name: /Dana Tester/ });
  expect((screen.getByRole("button", { name: /Sam Tester/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /Ken Tester/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Dana Tester/ }));
  await waitFor(() => expect(screen.getByLabelText("location").textContent).toBe("/"));
  expect(auth.openAccount).toHaveBeenCalledWith(7);
  expect(onClose).toHaveBeenCalled();
  // Recent accounts keep names only.
  expect(JSON.parse(localStorage.getItem("collaboratory.recentAccounts")!)).toEqual([{ id: 7, firstName: "Dana", lastName: "Tester" }]);
});

test("returning to the workspace closes an open account", async () => {
  auth.user = dana;
  auth.actor = admin;
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<h1>Today page</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(auth.closeAccount).toHaveBeenCalledOnce());
  expect(screen.getByRole("navigation", { name: "Staff workspace" })).toBeTruthy();
  expect(screen.getByText("Maximus Tester")).toBeTruthy();
});

test("opening an account from inside the workspace does not close it again", async () => {
  auth.user = admin;
  const shell = () => (
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<h1>Today page</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  const view = render(shell());
  // The picker opens Dana's account while the workspace is still on screen.
  auth.user = dana;
  auth.actor = admin;
  view.rerender(shell());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(auth.closeAccount).not.toHaveBeenCalled();
});

test("mobile navigation contains focus, locks the background, and restores the menu trigger", async () => {
  auth.user = admin;
  const user = userEvent.setup();
  const view = at(<AdminShell />, "/admin");
  expect(view.container.querySelector(".admin-top__view")?.getAttribute("aria-label")).toBe("View member site");
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  // A touch activation need not focus the button first (notably in WebKit).
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
  expect(drawer.contains(document.activeElement)).toBe(true);
  expect(view.container.inert).toBe(true);
  expect(document.body.classList.contains("modal-open")).toBe(true);
  for (let i = 0; i < 20; i++) {
    await user.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);
  }
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(view.container.inert).not.toBe(true);
  expect(document.activeElement).toBe(trigger);
  expect(document.body.classList.contains("modal-open")).toBe(false);
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Members" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("location").textContent).toBe("/admin/members");
});

test("staff see their tools, with admin-only and instructor actions locked", () => {
  auth.user = dana;
  auth.actor = staff;
  responses.set("/me/overview", { entitlement: { membership: false, dayPass: false }, pendingWaivers: 1, activeReservations: 0, canCheckIn: false, reasons: ["Sign all current required policies and waivers first."], recentCheckIns: [] });
  responses.set("/me/certifications", [{ id: 3, name: "Laser", status: "Expired", renewalDate: null }]);
  at(<AccountHomePage />);
  expect(screen.getByRole("region", { name: "Staff tools" })).toBeTruthy();
  const locked = screen.getByRole("region", { name: "Needs an instructor or admin" });
  expect(within(locked).getByRole("button", { name: /Change role/ })).toHaveProperty("disabled", true);
  expect(within(locked).getByRole("button", { name: /Sign off training/ })).toHaveProperty("disabled", true);
  expect(screen.getByRole("link", { name: /Assign an NFC card/ }).getAttribute("href")).toBe("/admin/access?member=7");
  expect(screen.getByRole("link", { name: /Move a booking/ }).getAttribute("href")).toBe("/admin/reservations?member=7");
  // Problems on the account come first, with the next step staff can take.
  expect(screen.getByText("Dana has no active membership or day pass.")).toBeTruthy();
  expect(screen.getByText("1 waiver needs signing.")).toBeTruthy();
  expect(screen.getByText("Dana's Laser certification is expired.")).toBeTruthy();
  // Check-in is unavailable and says why.
  expect(screen.getByRole("button", { name: /Check Dana in/ })).toHaveProperty("disabled", true);
  expect(screen.getAllByText("Sign all current required policies and waivers first.").length).toBeGreaterThan(0);
  // Waivers are never signed on someone's behalf.
  expect(screen.queryByText(/Sign a waiver/)).toBeNull();
});

test("admins get role changes as a tool; checking a member in posts for that member", async () => {
  auth.user = dana;
  auth.actor = admin;
  responses.set("/me/overview", { entitlement: { membership: true, dayPass: false }, pendingWaivers: 0, activeReservations: 1, canCheckIn: true, reasons: [], recentCheckIns: [] });
  at(<AccountHomePage />);
  const tools = screen.getByRole("region", { name: "Admin tools" });
  expect(within(tools).getByRole("link", { name: /Change role/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Needs an instructor" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Check Dana in/ }));
  await screen.findByText("Dana is checked in.");
  expect(api).toHaveBeenCalledWith("/me/check-ins", { method: "POST", body: {} });
});

test("your own account shows member actions only", () => {
  auth.user = admin;
  auth.actor = admin;
  at(<AccountHomePage />);
  expect(screen.getByRole("region", { name: "For you" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Admin tools" })).toBeNull();
  expect(screen.queryByRole("region", { name: /Needs an instructor/ })).toBeNull();
});
