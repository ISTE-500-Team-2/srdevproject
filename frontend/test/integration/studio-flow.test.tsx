import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  waitFor,
  render,
  screen,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../../src/App";
import { api, setAccessToken, setCsrfToken } from "../../src/lib/api";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";
import { StudioService } from "../../../backend/src/studios/service";
let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
});
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  setAccessToken(null);
  setCsrfToken(null);
  if (bridge) await bridge.close();
});
test("member books monthly studio, staff confirms real manual receipt, cancellation shows refund and releases calendar", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  const staff = await api<any>("/auth/demo", {
    method: "POST",
    body: { role: "admin" },
  });
  const service = new StudioService(bridge.pool);
  await service.configure(staff.user.id, 1, {
    monthlyCents: 25000,
    cancellationPolicy: "full_before_start",
    policyConfirmed: true,
    revision: 2,
  });
  await api("/auth/logout", { method: "POST" });
  setAccessToken(null);
  setCsrfToken(null);
  await api("/auth/demo", { method: "POST", body: { role: "member" } });
  render(
    <MemoryRouter initialEntries={["/studios"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Studio spaces" });
  // Only the configured studio is offered; members pick a size first.
  await userEvent.click(
    await screen.findByRole("button", { name: /^Small studios/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Reserve a small studio" });
  // Page forward to January 2030 and pick the 31st (ends Feb 28, exclusive).
  while (!within(dialog).queryByText("January 2030"))
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Next month" }),
    );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Thu, Jan 31, 2030" }),
  );
  expect(within(dialog).getByText("Yours through Wed, Feb 27, 2030.")).toBeTruthy();
  expect(
    (within(dialog).getByRole("radio", { name: /Small studio 1/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "Hold studio" }));
  await within(dialog).findByText("Small studio 1 is held for you");
  const r = (await bridge.pool.query("SELECT * FROM app_studio_rental"))
    .rows[0];
  expect(r).toMatchObject({ starts_on: expect.anything(), payment_status: "unpaid" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  const rentals = await screen.findByRole("region", { name: "Your rentals" });
  expect(within(rentals).getByText("Awaiting payment")).toBeTruthy();
  await service.manualPay(staff.user.id, r.id, "test fixture receipt 123");
  // Pending rentals refresh on their own when the window regains focus.
  window.dispatchEvent(new Event("focus"));
  await within(rentals).findByText("Confirmed");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const cancel = within(rentals).getByRole("button", { name: "Cancel rental" });
  await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false));
  await userEvent.click(cancel);
  await screen.findByText("Small studio 1 cancelled.");
  const cancelled = (await bridge.pool.query("SELECT * FROM app_studio_rental"))
    .rows[0];
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.refund_cents).toBe(25000);
  expect(cancelled.payment_status).toBe("refund_pending");
  // The cancelled rental moves to past rentals and the studio is free again.
  await screen.findByText("Past rentals (1)");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Small studios/ }),
  );
  const again = screen.getByRole("dialog", { name: "Reserve a small studio" });
  while (!within(again).queryByText("January 2030"))
    await userEvent.click(within(again).getByRole("button", { name: "Next month" }));
  expect(
    within(again)
      .getByRole("button", { name: "Thu, Jan 31, 2030" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test('reservations studio modal uses the current catalog and saves one real hold without claiming paid access',async()=>{
  cleanup();vi.stubGlobal('fetch',bridge.fetch);
  render(<MemoryRouter initialEntries={['/reservations']}><App /></MemoryRouter>);
  await screen.findByRole('heading',{name:'Studio Spaces'});
  const studio=(await bridge.pool.query('SELECT * FROM app_studio WHERE id=1')).rows[0];
  const heading=await screen.findByRole('heading',{name:'Small studio 1'});
  const card=heading.closest('button')!;
  expect(card.textContent).toContain('$250.00');
  await userEvent.click(card);
  const dialog=screen.getByRole('dialog',{name:'Reserve Small studio 1'});
  fireEvent.change(within(dialog).getByLabelText(/Rental start date/),{target:{value:'2031-01-31'}});
  expect(within(dialog).getByText(/2031-01-31 through 2031-02-28/)).toBeTruthy();
  const hold=within(dialog).getByRole('button',{name:'Hold and pay with staff'});
  await waitFor(()=>expect(hold.hasAttribute('disabled')).toBe(false));
  await userEvent.click(hold);
  await screen.findByText(/Small studio 1 held until/);
  const rows=(await bridge.pool.query("SELECT * FROM app_studio_rental WHERE starts_on='2031-01-31'")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({studio_id:studio.id,status:'pending',payment_status:'unpaid',amount_cents:25000});
});
