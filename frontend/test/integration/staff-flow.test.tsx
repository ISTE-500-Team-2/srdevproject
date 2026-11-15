import { waiverAcceptance } from '../../../backend/test/helpers/waiver';
import { confirmationToken } from '../../../backend/test/helpers/confirmation';
// @vitest-environment jsdom
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { setAccessToken, setCsrfToken } from "../../src/lib/api";
import { lastWorkspacePathKey } from "../../src/components/admin/people";
import App from "../../src/App";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (bridge) await bridge.close();
}, 30000);
// Each scenario opens a fresh browser tab against the shared server.
beforeEach(() => {
  cleanup();
  setAccessToken(null);
  setCsrfToken(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", bridge.fetch);
});
function mount(path = "/admin") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
async function direct(path: string, body: unknown, csrf?: string) {
  return bridge.fetch("/api" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}
const count = async (sql: string, id: number) =>
  (await bridge.pool.query(sql, [id])).rows[0].n;

type Member = { id: number; name: string; email: string; password: string };
/** A confirmed member who signed every required waiver, then signed out. */
async function registerMember(lastName: string): Promise<Member> {
  const password = `A!${randomBytes(24).toString("hex")}`,
    email = randomUUID() + "@example.invalid";
  const registration = await direct("/auth/register", {
    firstName: "Taylor",
    lastName,
    email,
    password,
    phone: "0000000000",
    dob: "2000-01-01",
  });
  expect(registration.status).toBe(202);
  const confirmed = await direct("/auth/confirm",{token:await confirmationToken(bridge.pool,email)});
  expect(confirmed.status).toBe(200);
  const session = (await confirmed.json()).data;
  const waivers = (await (await bridge.fetch("/api/me/waivers")).json()).data;
  for (const waiver of waivers)
    expect(
      (
        await direct(
          `/me/waivers/${waiver.id}/sign`,
          waiverAcceptance(waiver),
          session.csrfToken,
        )
      ).status,
    ).toBe(200);
  expect((await direct("/auth/logout", {}, session.csrfToken)).status).toBe(
    204,
  );
  return { id: session.user.id, name: `Taylor ${lastName}`, email, password };
}
/** Signs in as the demo account with plain staff rights; returns the session's CSRF token. */
async function signInAsStaff(): Promise<string> {
  const demo = await direct("/auth/demo", { role: "admin" });
  expect(demo.status).toBe(200);
  // Exercise a real staff identity, not an administrator standing in for staff.
  await bridge.pool.query(`UPDATE user_role SET roleid=(SELECT roleid FROM role WHERE role='staff') WHERE userid=(SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid')`);
  const staffSession = (await (await bridge.fetch('/api/auth/session')).json()).data;
  expect(staffSession.user.role).toBe('staff');
  return (await demo.json()).data.csrfToken;
}
/** Opens the member's record from the staff Members page. */
async function openRecord(user: ReturnType<typeof userEvent.setup>, member: Member) {
  mount("/admin/members");
  await user.click(
    await screen.findByRole(
      "button",
      { name: new RegExp(member.name) },
      { timeout: 20000 },
    ),
  );
}

test("staff smoke journey: create a plan, record an external payment that issues it, and see it in the member's history after a reload", async () => {
  const member = await registerMember("UI Buyer");
  await signInAsStaff();
  mount("/admin/plans");
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "New plan" }, { timeout: 20000 }),
  );
  const create = screen.getByRole("form", { name: "Create a plan" });
  // Staff get the workspace sidebar, not the member site header.
  const workspaceNav = screen.getByRole('navigation', {name:'Staff workspace'});
  expect(within(workspaceNav).getByRole('link', {name:'Plans'}).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('navigation', {name:'Primary navigation'})).toBeNull();
  expect(window.localStorage.length).toBe(0);
  // The workspace remembers only the page staff were on; no tokens or session data.
  expect(Object.keys(window.sessionStorage)).toEqual([lastWorkspacePathKey]);
  expect(window.sessionStorage.getItem(lastWorkspacePathKey)).toBe("/admin/plans");
  const name = "UI monthly plan";
  await user.type(within(create).getByLabelText("Plan name"), name);
  fireEvent.change(within(create).getByLabelText("Price (USD)"), {
    target: { value: "35.25" },
  });
  await user.type(within(create).getByLabelText("Benefits"), "Maker access");
  await user.type(
    within(create).getByLabelText("Reason for change"),
    "Team UI workflow test",
  );
  await user.click(within(create).getByRole("button", { name: "Create plan" }));
  await screen.findByRole("heading", { name }, { timeout: 20000 });
  const plan = (
    await bridge.pool.query(
      "SELECT tierid AS id FROM membership_tiers WHERE tiername=$1",
      [name],
    )
  ).rows[0];
  await user.click(
    within(
      screen.getByRole("navigation", { name: "Staff workspace" }),
    ).getByRole("link", { name: "Members", exact: true }),
  );
  await user.click(
    await screen.findByRole(
      "button",
      { name: new RegExp(member.name) },
      { timeout: 20000 },
    ),
  );
  await user.click(await screen.findByRole("button", { name: "Sell or record a payment" }, { timeout: 20000 }));
  await user.selectOptions(await screen.findByLabelText("How will the member pay?"), "external");
  const issue = await screen.findByRole(
    "form",
    { name: "Record external payment or waive payment" },
    { timeout: 20000 },
  );
  await user.selectOptions(
    within(issue).getByLabelText("Access plan"),
    String(plan.id),
  );
  await user.selectOptions(
    within(issue).getByLabelText("Payment received or waived"),
    "paid",
  );
  await user.selectOptions(
    within(issue).getByLabelText("Payment method"),
    "cash",
  );
  await user.type(
    within(issue).getByLabelText(/External receipt/),
    "UI-RECEIPT",
  );
  await user.type(
    within(issue).getByLabelText("Reason for change"),
    "Cash received in UI test",
  );
  await user.click(within(issue).getByRole("button", { name: "Record payment and issue access" }));
  await screen.findByText(
    "Access issued and the payment recorded.",
    {},
    { timeout: 20000 },
  );
  expect(
    await count("SELECT COUNT(*)::int AS n FROM user_membership WHERE userid=$1", member.id),
  ).toBe(1);
  expect(
    (
      await bridge.pool.query(
        "SELECT price::text AS amount,paymentstatus AS status FROM payment WHERE userid=$1",
        [member.id],
      )
    ).rows[0],
  ).toEqual({ amount: "35.25", status: "paid" });

  // A reload keeps only the refresh cookie: the record is read again from the server.
  cleanup();
  setAccessToken(null); setCsrfToken(null);
  await openRecord(user, member);
  await screen.findByRole(
    "heading",
    { name: "Payments" },
    { timeout: 20000 },
  );
  expect(screen.getAllByText(/UI-RECEIPT/).length).toBeGreaterThan(0);
}, 180000);

test("suspending a member's facility access blocks their sign-in and leaves no session, refresh token or check-in", async () => {
  const member = await registerMember("UI Suspended");
  await signInAsStaff();
  const user = userEvent.setup();
  await openRecord(user, member);
  await user.click(await screen.findByRole("button", { name: "Change facility access" }, { timeout: 20000 }));
  const access = screen.getByRole("form", { name: "Facility access" });
  await user.click(within(access).getByRole("radio", { name: /^Suspended/ }));
  await user.type(
    within(access).getByLabelText("Reason"),
    "Temporary UI access hold",
  );
  await user.click(
    within(access).getByRole("button", { name: "Save access" }),
  );
  await screen.findByText(/facility access is suspended/, {}, { timeout: 20000 });

  cleanup();
  expect((await direct("/auth/login", { email: member.email, password: member.password })).status).toBe(403);
  expect(await count('SELECT COUNT(*)::int AS n FROM app_session WHERE userid=$1', member.id)).toBe(0);
  expect(await count('SELECT COUNT(*)::int AS n FROM app_refresh_family WHERE userid=$1 AND NOT revoked', member.id)).toBe(0);
  expect(await count("SELECT COUNT(*)::int AS n FROM check_in WHERE userid=$1", member.id)).toBe(0);
});

test("account status changes quote their reason while blocked and keep the separate facility access hold and membership", async () => {
  const member = await registerMember("UI Status");
  const csrf = await signInAsStaff();
  // Same starting point as a member sold a plan and then put on a facility access hold.
  const created = await direct("/admin/plans", {
    name: "UI status plan",
    kind: "membership",
    price: "35.25",
    months: 1,
    benefits: "Maker access",
    active: true,
    reason: "Team UI workflow test",
  }, csrf);
  expect(created.status).toBe(201);
  expect((await direct(`/admin/users/${member.id}/entitlements`, {
    requestId: randomUUID(),
    planId: (await created.json()).data.id,
    startsAt: new Date(Date.now() - 60000).toISOString(),
    validDate: null,
    paymentStatus: "paid",
    method: "cash",
    reference: "UI-RECEIPT",
    reason: "Cash received in UI test",
  }, csrf)).status).toBe(201);
  const { revision } = (await (await bridge.fetch(`/api/admin/users/${member.id}`)).json()).data.user;
  expect((await direct(`/admin/users/${member.id}/access`, { status: "suspended", revision, reason: "Temporary UI access hold" }, csrf)).status).toBe(200);

  const user = userEvent.setup();
  await openRecord(user, member);
  const words:Record<string,RegExp>={suspended:/^On hold/,inactive:/^Closed/,active:/^Active/};
  for (const status of ['suspended','inactive','active']) {
    await user.click(await screen.findByRole('button',{name:'Change account status'},{timeout:20000}));
    const account = await screen.findByRole('form',{name:'Account status'});
    await user.click(within(account).getByRole('radio',{name:words[status]}));
    await user.type(within(account).getByLabelText('Reason'),'Private account review');
    await user.click(within(account).getByRole('button',{name:'Save status'}));
    await waitFor(()=>expect(screen.queryByRole('form',{name:'Account status'})).toBeNull(),{timeout:20000});
    await waitFor(async()=>{
      const row = (await bridge.pool.query('SELECT status FROM "user" WHERE userid=$1',[member.id])).rows[0];
      expect(row.status).toBe(status);
    });
    // While the account is blocked, the record quotes the reason in the verdict and the Account panel.
    if (status !== 'active') expect((await screen.findAllByText(/Private account review/,{},{timeout:20000})).length).toBeGreaterThan(0);
  }
  const retained = (await bridge.pool.query('SELECT accessstatus FROM "user" WHERE userid=$1',[member.id])).rows[0];
  expect(retained.accessstatus).toBe('suspended');
  expect(await count('SELECT COUNT(*)::int AS n FROM user_membership WHERE userid=$1', member.id)).toBe(1);
});
