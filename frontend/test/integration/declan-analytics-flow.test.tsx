import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../../src/App";
import { zonedDay } from "../../src/lib/display";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";
let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
}, 120000);
afterEach(cleanup);
afterAll(async () => {
  vi.unstubAllGlobals();
  await bridge?.close();
}, 30000);
async function login(role = "admin") {
  vi.stubGlobal("fetch", bridge.fetch);
  expect(
    (
      await bridge.fetch("/api/auth/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
    ).status,
  ).toBe(200);
}
function mount(tab: string) {
  render(
    <MemoryRouter initialEntries={["/admin?tab=" + tab]}>
      <App />
    </MemoryRouter>,
  );
}
test("analytics uses the full settled ledger, real check-ins/classes and zero-filled date buckets", async () => {
  await login();
  const member = (
    await bridge.pool.query(
      `SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
    )
  ).rows[0].userid;
  const today = zonedDay("America/New_York");
  await bridge.pool.query(
    `INSERT INTO payment(userid,price,paymentstatus,paymentdate,method) SELECT $1,1.25,'paid',($2::date+time '12:00') AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC','cash' FROM generate_series(1,60)`,
    [member, today],
  );
  await bridge.pool.query(
    `INSERT INTO payment(userid,price,paymentstatus,paymentdate,method) VALUES ($1,20,'refunded',($2::date+time '12:00') AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC','cash'),($1,999,'void',($2::date+time '12:00') AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC','cash')`,
    [member, today],
  );
  mount("analytics");
  await screen.findByRole("heading", { name: /^Revenue by/ });
  const user = userEvent.setup();
  const totals = screen.getByText("Net receipts").closest("dl")!;
  expect(within(totals).getByText("$75.00")).toBeTruthy();
  expect(within(totals).getByText("$95.00")).toBeTruthy();
  expect(within(totals).getByText("$20.00")).toBeTruthy();
  expect(screen.queryByText("Active Users: 56")).toBeNull();
  const visits = screen.getByText("Visits").closest("article")!;
  expect(within(visits).getByText("0")).toBeTruthy();
  expect(screen.getByText("Nobody has checked in yet today.")).toBeTruthy();
  expect(screen.getByText("No classes in this period.")).toBeTruthy();
  // Custom dates and grouping apply as soon as they change.
  await user.selectOptions(screen.getByLabelText("Date range"), "custom");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: today } });
  fireEvent.change(screen.getByLabelText("Through"), {
    target: { value: today },
  });
  await user.click(screen.getByRole("radio", { name: "Daily" }));
  const table = await screen.findByRole("table", {
    name: "Revenue by period (period starting date)",
  });
  await vi.waitFor(() =>
    expect(within(table).getAllByRole("row")).toHaveLength(2),
  );
  expect(within(table).getByRole("rowheader", { name: today })).toBeTruthy();
  expect(within(table).getByText("61")).toBeTruthy();
});
test("combined waiver/certification tab mounts real admin tools instead of personal endpoints", async () => {
  await login();
  mount("adminCertWaiver");
  await screen.findByRole("heading", { name: "Certifications & waivers" });
  await screen.findByRole("radio", { name: /Needs attention/ });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Waivers & policies" }));
  await user.click(await screen.findByRole("button", { name: "New waiver" }));
  await screen.findByRole("button", { name: "Publish version" });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(
    screen.getByRole("button", { name: "Certifications" }),
  );
  await user.click(await screen.findByRole("button", { name: "New certification" }));
  await screen.findByRole("button", { name: "Save certification" });
});
