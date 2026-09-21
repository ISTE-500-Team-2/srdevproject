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
    revision: 1,
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
  await screen.findByRole("heading", { name: "Monthly studio rentals" });
  await screen.findByRole("heading", { name: "Small studio 1" });
  fireEvent.change(screen.getByLabelText("Rental start date"), {
    target: { value: "2030-01-31" },
  });
  const card = screen
    .getAllByRole("heading", { name: "Small studio 1" })[0]
    .closest("article")!;
  await userEvent.click(
    within(card).getByRole("button", { name: "Hold and pay with staff" }),
  );
  await screen.findByText(
    /Pay with staff before then; your booking is not confirmed yet/,
  );
  const r = (await bridge.pool.query("SELECT * FROM app_studio_rental"))
    .rows[0];
  expect(r.payment_status).toBe("unpaid");
  await service.manualPay(staff.user.id, r.id, "test fixture receipt 123");
  await userEvent.click(
    screen.getByRole("button", {
      name: "Refresh availability and payment status",
    }),
  );
  await screen.findByText("paid", { exact: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const cancel = screen.getByRole("button", { name: "Cancel rental" });
  // The refresh renders returned rental data before its action finally clears
  // busy. Wait for the same enabled control a person can actually interact with.
  await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false));
  await userEvent.click(cancel);
  await screen.findByText("Rental cancelled. Check its refund status below.");
  const cancelled = (await bridge.pool.query("SELECT * FROM app_studio_rental"))
    .rows[0];
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.refund_cents).toBe(25000);
  expect(cancelled.payment_status).toBe("refund_pending");
  await waitFor(() =>
    expect(
      within(
        screen
          .getAllByRole("heading", { name: "Small studio 1" })[0]
          .closest("article")!,
      )
        .getByRole("button", { name: "Hold and pay with staff" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
});
