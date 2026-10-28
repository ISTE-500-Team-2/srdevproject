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
import { MemoryRouter, useLocation } from "react-router-dom";
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
  const cancel = within(rentals).getByRole("button", { name: "Cancel rental" });
  await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false));
  await userEvent.click(cancel);
  // Cancelling is confirmed in a dialog with a press-and-hold button.
  const confirm = screen.getByRole("dialog", { name: "Cancel Small studio 1?" });
  expect(within(confirm).getByText(/You'll get \$250\.00 back/)).toBeTruthy();
  fireEvent.keyDown(within(confirm).getByRole("button", { name: /Hold to cancel rental/ }), { key: " " });
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

function CurrentRoute() {
  const { pathname, search, hash } = useLocation();
  return <output aria-label="Current route">{pathname + search + hash}</output>;
}

test('Equipment replaces the old combined page without breaking studio navigation or saved bookmarks',async()=>{
  cleanup();
  const requests:string[]=[];
  const captured:typeof bridge.fetch=async(input,init)=>{
    requests.push(String(input));
    return bridge.fetch(input,init);
  };
  vi.stubGlobal('fetch',captured);
  render(<MemoryRouter initialEntries={['/reservations?source=bookmark#my-reservations']}><App /><CurrentRoute /></MemoryRouter>);
  await screen.findByRole('heading',{name:'Equipment',exact:true});
  await screen.findByRole('button',{name:/3D Printer/});
  expect(screen.getByLabelText('Current route').textContent).toBe('/equipment?source=bookmark#my-reservations');
  expect(screen.queryByRole('heading',{name:'Studio Spaces'})).toBeNull();
  expect(screen.queryByLabelText('Studio size filter')).toBeNull();
  expect(requests.some(url=>url.includes('/api/studios'))).toBe(false);
  const nav=screen.getByRole('navigation',{name:'Primary navigation'});
  expect(within(nav).getByRole('link',{name:'Equipment',exact:true}).getAttribute('href')).toBe('/equipment');
  expect(within(nav).queryByRole('link',{name:'Reservations',exact:true})).toBeNull();
  await userEvent.click(within(nav).getByRole('link',{name:'Studios',exact:true}));
  await screen.findByRole('heading',{name:'Studio spaces'});
  expect(screen.getByLabelText('Current route').textContent).toBe('/studios');
  expect(requests.some(url=>url.includes('/api/studios'))).toBe(true);
});
