import { afterAll, beforeAll, expect, test, vi } from "vitest";
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
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";
let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge({
    devices: {
      cardHashKey: "browser-test-card-hash-key-isolated",
      readers: [
        {
          id: "test",
          secret: "browser-test-reader-secret-isolated",
          kind: "building",
        },
      ],
    },
  });
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await bridge?.close();
}, 30000);
test("staff training UI configures approved expiry, records actual instructor training and revokes safely", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  let login = await bridge.fetch("/api/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  expect(login.status).toBe(200);
  const member = (
    await bridge.pool.query(
      `SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
    )
  ).rows[0].userid;
  render(
    <MemoryRouter initialEntries={["/training"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Name"), "UI printer safety");
  await user.type(screen.getByLabelText("Approved validity in days"), "90");
  await user.type(
    screen.getByLabelText("Policy approval/reference"),
    "Sponsor-approved training policy",
  );
  await user.click(screen.getByRole("button", { name: "Save certification" }));
  await screen.findByRole("heading", { name: "UI printer safety" });
  await user.type(await screen.findByLabelText("Member ID"), String(member));
  await user.click(screen.getByRole("button", { name: "Load member" }));
  await screen.findByRole("heading", { name: "Approve completed training" });
  const cert = (
    await bridge.pool.query(
      "SELECT certid FROM certifications WHERE name='UI printer safety'",
    )
  ).rows[0].certid;
  await user.selectOptions(
    screen.getByLabelText("Certification"),
    String(cert),
  );
  const t = new Date(Date.now() - 86400000),
    local = new Date(t.getTime() - t.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  fireEvent.change(screen.getByLabelText("Actual training date/time"), {
    target: { value: local },
  });
  await user.type(
    screen.getByLabelText("Verification reference"),
    "Observed successful safety demonstration",
  );
  await user.type(screen.getByLabelText("Reason"), "Completed in person");
  await user.click(screen.getByLabelText(/I conducted or verified/));
  await user.click(screen.getByRole("button", { name: "Approve training" }));
  await screen.findByText("Current · active");
  const saved = (
    await bridge.pool.query(
      "SELECT * FROM user_certifications WHERE userid=$1 AND certid=$2",
      [member, cert],
    )
  ).rows[0];
  expect(saved.approved_by).toBeTruthy();
  expect(saved.verified_in_person).toBe(true);
  expect(saved.trained_at).toBeTruthy();
  await user.type(
    screen.getByLabelText("Revocation/retraining reason"),
    "Retraining required after incident",
  );
  await user.click(
    screen.getByRole("button", { name: "Revoke UI printer safety" }),
  );
  await screen.findByText("Not current · revoked");
  cleanup();
});
test("staff reports UI reads actual ledger instead of sample charts", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  await bridge.pool.query(
    `INSERT INTO payment(userid,price,paymentstatus,paymentdate,method) SELECT userid,125.50,'paid',NOW() AT TIME ZONE 'UTC','cash' FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
  );
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Reports" }));
  await screen.findByRole("heading", { name: "Recorded revenue" });
  const table = screen.getAllByRole("table")[0];
  expect(within(table).getByText("cash")).toBeTruthy();
  expect(within(table).getAllByText("$125.50")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy();
  expect(screen.queryByText(/Design preview: all charts/)).toBeNull();
  cleanup();
});

test("staff card assignment, revocation and timed override UI save audited records", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Reader access" }),
  );
  const member = (
    await bridge.pool.query(
      `SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
    )
  ).rows[0].userid;
  await user.type(await screen.findByLabelText("Member ID"), String(member));
  await user.click(screen.getByRole("button", { name: "Load cards" }));
  await screen.findByRole("heading", { name: "Assign scanned card" });
  await user.type(screen.getByLabelText("Card UID"), "04:A1:B2:C3:D4:E5:F6");
  await user.type(screen.getByLabelText("Card label"), "UI test card");
  await user.type(
    screen.getByLabelText("Assignment reason"),
    "Verified identity",
  );
  await user.click(screen.getByRole("button", { name: "Assign card" }));
  await screen.findByRole("heading", { name: "UI test card" });
  await user.type(screen.getByLabelText("Revocation reason"), "Lost card");
  await user.click(screen.getByRole("button", { name: "Revoke UI test card" }));
  await screen.findByText(/Revoked · assigned/);
  const equipment = (
    await bridge.pool.query(
      "SELECT equipmentid FROM equipment ORDER BY equipmentid LIMIT 1",
    )
  ).rows[0].equipmentid;
  await user.type(screen.getByLabelText("Resource ID"), String(equipment));
  const t = new Date(Date.now() + 10 * 60000),
    local = new Date(t.getTime() - t.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: local } });
  const form = screen
    .getByRole("heading", { name: "Short staff access override" })
    .closest("form")!;
  await user.type(
    within(form).getByLabelText("Reason"),
    "Supervised operation",
  );
  await user.click(
    screen.getByRole("button", { name: "Create timed override" }),
  );
  await screen.findByText(/Supervised operation · ends/);
  const card = (
    await bridge.pool.query(
      "SELECT active FROM app_access_card WHERE label='UI test card'",
    )
  ).rows[0];
  expect(card.active).toBe(false);
  expect(
    (
      await bridge.pool.query(
        "SELECT COUNT(*)::int AS n FROM app_access_override",
      )
    ).rows[0].n,
  ).toBe(1);
  cleanup();
});
