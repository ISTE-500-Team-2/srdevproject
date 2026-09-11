// @vitest-environment jsdom
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
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

test("staff React flow creates a plan, issues access/payment, survives reload, shows member history and enforces suspension", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  const password = randomBytes(24).toString("hex"),
    email = randomUUID() + "@example.invalid";
  const registration = await direct("/auth/register", {
    firstName: "Taylor",
    lastName: "UI Member",
    email,
    password,
    phone: "0000000000",
  });
  expect(registration.status).toBe(201);
  const session = (await registration.json()).data,
    id = session.user.id;
  const waivers = (await (await bridge.fetch("/api/me/waivers")).json()).data;
  for (const waiver of waivers)
    expect(
      (
        await direct(
          `/me/waivers/${waiver.id}/sign`,
          { accepted: true },
          session.csrfToken,
        )
      ).status,
    ).toBe(200);
  expect((await direct("/auth/logout", {}, session.csrfToken)).status).toBe(
    204,
  );
  expect((await direct("/auth/demo", { role: "admin" })).status).toBe(200);
  // Exercise a real staff identity, not an administrator standing in for staff.
  await bridge.pool.query(`UPDATE user_role SET roleid=(SELECT roleid FROM role WHERE role='staff') WHERE userid=(SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid')`);
  const staffSession = (await (await bridge.fetch('/api/auth/session')).json()).data;
  expect(staffSession.user.role).toBe('staff');
  const user = userEvent.setup();
  mount("/admin?tab=plans");
  const create = await screen.findByRole(
    "form",
    { name: "Create a plan" },
    { timeout: 20000 },
  );
  expect(within(screen.getByRole('navigation', {name:'Primary navigation'})).getByRole('link', {name:'Staff workspace'})).toBeTruthy();
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
      screen.getByRole("navigation", { name: "Staff sections" }),
    ).getByRole("button", { name: "Members", exact: true }),
  );
  await user.click(
    await screen.findByRole(
      "button",
      { name: /Taylor UI Member/ },
      { timeout: 20000 },
    ),
  );
  const issue = await screen.findByRole(
    "form",
    { name: "Issue membership or day pass" },
    { timeout: 20000 },
  );
  await user.selectOptions(
    within(issue).getByLabelText("Access plan"),
    String(plan.id),
  );
  await user.selectOptions(
    within(issue).getByLabelText("Initial payment record"),
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
  await user.click(within(issue).getByRole("button", { name: "Issue access" }));
  await screen.findByText(
    "Access issued and payment record saved.",
    {},
    { timeout: 20000 },
  );
  expect(
    (
      await bridge.pool.query(
        "SELECT COUNT(*)::int AS n FROM user_membership WHERE userid=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await bridge.pool.query(
        "SELECT price::text AS amount,paymentstatus AS status FROM payment WHERE userid=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ amount: "35.25", status: "paid" });

  cleanup();
  mount();
  await user.click(
    await screen.findByRole(
      "button",
      { name: /Taylor UI Member/ },
      { timeout: 20000 },
    ),
  );
  await screen.findByRole(
    "heading",
    { name: /Recent payment records/ },
    { timeout: 20000 },
  );
  expect(screen.getAllByText(/UI-RECEIPT/).length).toBeGreaterThan(0);
  const access = screen.getByRole("form", { name: "Facility access control" });
  await user.selectOptions(
    within(access).getByLabelText("Facility access"),
    "suspended",
  );
  await user.type(
    within(access).getByLabelText("Reason for change"),
    "Temporary UI access hold",
  );
  await user.click(
    within(access).getByRole("button", { name: "Save facility access" }),
  );
  await screen.findByText("Facility access updated.", {}, { timeout: 20000 });

  cleanup();
  expect((await direct("/auth/login", { email, password })).status).toBe(200);
  mount("/membership");
  await screen.findByRole(
    "heading",
    { name: "Your access records" },
    { timeout: 20000 },
  );
  await screen.findByText("suspended", {}, { timeout: 20000 });
  await screen.findByText(/UI-RECEIPT/, {}, { timeout: 20000 });
  expect(screen.queryByRole("link", { name: "Staff workspace" })).toBeNull();
  await user.click(
    within(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).getByRole("link", { name: "Home", exact: true }),
  );
  const checkin = await screen.findByRole(
    "button",
    { name: "Check in" },
    { timeout: 20000 },
  );
  await waitFor(() =>
    expect((checkin as HTMLButtonElement).disabled).toBe(true),
  );
  expect(
    screen.getByText(/Facility access is suspended or revoked; contact staff/),
  ).toBeTruthy();
  const latest = (await (await bridge.fetch("/api/auth/session")).json()).data;
  expect(
    (
      await direct(
        "/me/check-ins",
        { location: "Should not be saved" },
        latest.csrfToken,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await bridge.pool.query(
        "SELECT COUNT(*)::int AS n FROM check_in WHERE userid=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
}, 240000);
