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
    data: path ? (responses.get(path) ?? responses.get(path.split("?")[0]) ?? null) : null,
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

test("staff land in the workspace; members get their home; an open account gets the action screen", async () => {
  auth.user = admin;
  at(<HomeRoute />);
  expect(screen.getByLabelText("location").textContent).toBe("/admin");
  cleanup();

  auth.user = dana;
  auth.actor = admin;
  responses.set("/me/overview", { userId:dana.id, entitlement: { membership: true, dayPass: false }, pendingWaivers: 0, activeReservations: 0, canCheckIn: true, reasons: [], recentCheckIns: [] });
  at(<HomeRoute />);
  // The account screen is part of the separately loaded member area.
  expect(await screen.findByRole("heading", { name: "What would you like to do?" }, { timeout: 5000 })).toBeTruthy();
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

test("View a member sits right under Members and opens the account picker", () => {
  auth.user = admin;
  at(<AdminShell />, "/admin");
  const nav = screen.getByRole("navigation", { name: "Staff workspace" });
  const people = within(nav).getByRole("group", { name: "People" });
  const items = Array.from(people.querySelectorAll(".admin-nav__item")).map((item) => item.textContent);
  expect(items.slice(0, 2)).toEqual(["Members", "View a member"]);
  fireEvent.click(within(people).getByRole("button", { name: "View a member" }));
  expect(screen.getByRole("dialog", { name: "Whose account?" })).toBeTruthy();
});

test("View a member in the mobile drawer swaps the drawer for the account picker", () => {
  auth.user = admin;
  at(<AdminShell />, "/admin");
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
  fireEvent.click(within(drawer).getByRole("button", { name: "View a member" }));
  expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).toBeNull();
  const picker = screen.getByRole("dialog", { name: "Whose account?" });
  expect(picker.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("staff see their tools, with admin-only and instructor actions locked", () => {
  auth.user = dana;
  auth.actor = staff;
  responses.set("/me/overview", { userId:dana.id, entitlement: { membership: false, dayPass: false }, pendingWaivers: 1, activeReservations: 0, canCheckIn: false, reasons: ["Sign all current required policies and waivers first."], recentCheckIns: [] });
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
  responses.set("/me/overview", { userId:dana.id, entitlement: { membership: true, dayPass: false }, pendingWaivers: 0, activeReservations: 1, canCheckIn: true, checkInBuildingId:2, buildings:[{id:1,name:'Main',status:'available'},{id:2,name:'Annex',status:'available'}], reasons: [], recentCheckIns: [] });
  at(<AccountHomePage />);
  const tools = screen.getByRole("region", { name: "Admin tools" });
  expect(within(tools).getByRole("link", { name: /Change role/ })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Needs an instructor" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Check Dana in/ }));
  await screen.findByText("Dana is checked in.");
  expect(api).toHaveBeenCalledWith("/me/check-ins", { method: "POST", body: {buildingId:2} });
});

test("staff choose the actual arrival building; a stale overview cannot authorize the changed target", async () => {
  auth.user = dana; auth.actor = admin;
  const overview = { userId:dana.id, entitlement: { membership:true, dayPass:false }, pendingWaivers:0, activeReservations:0,
    canCheckIn:true, checkInBuildingId:2, buildings:[{id:1,name:'Main',status:'available'},{id:2,name:'Annex',status:'available'}], reasons:[], recentCheckIns:[] };
  responses.set('/me/overview',overview);
  at(<AccountHomePage />);
  expect(screen.getByLabelText('Check-in building')).toHaveProperty('value','2');
  fireEvent.change(screen.getByLabelText('Check-in building'),{target:{value:'1'}});
  expect(screen.getByRole('button',{name:/Check Dana in/})).toHaveProperty('disabled',true);
  expect(api).not.toHaveBeenCalled();
  responses.set('/me/overview?buildingId=1',{...overview,checkInBuildingId:1});
  fireEvent.change(screen.getByLabelText('Check-in building'),{target:{value:'1'}});
  fireEvent.click(screen.getByRole('button',{name:/Check Dana in/}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('/me/check-ins',{method:'POST',body:{buildingId:1}}));
});

test("your own account shows member actions only", () => {
  auth.user = admin;
  auth.actor = admin;
  at(<AccountHomePage />);
  expect(screen.getByRole("region", { name: "For you" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Admin tools" })).toBeNull();
  expect(screen.queryByRole("region", { name: /Needs an instructor/ })).toBeNull();
});

 test("only admins can queue a member password reset and see delivery errors", async () => {
  auth.user = dana;
  auth.actor = admin;
  api.mockResolvedValueOnce({ message: "Password reset email queued. The link expires in 30 minutes." });
  at(<AccountHomePage />);
  fireEvent.click(screen.getByRole("button", { name: /Send password reset email/ }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/admin/users/7/password-reset", { method: "POST", body: {} }));
  expect(await screen.findByText(/Password reset email queued/)).toBeTruthy();
  api.mockRejectedValueOnce(new Error("Email delivery is disabled in this environment."));
  fireEvent.click(screen.getByRole("button", { name: /Send password reset email/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("Email delivery is disabled");
  cleanup();
  auth.actor = staff;
  at(<AccountHomePage />);
  expect(screen.queryByRole("button", { name: /Send password reset email/ })).toBeNull();
});
