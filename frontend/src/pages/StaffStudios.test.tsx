// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Rental, Studio } from "../lib/studioContracts";
import { StaffStudios } from "./StaffStudios";

const { api, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { roles: ["staff"] } as unknown, openAccount: vi.fn() },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: Error) => error.message,
  ApiError: class extends Error {},
}));

const hold = "2026-10-30T16:00:00Z";
const paris: Studio = {
  id: 7,
  name: "Paris",
  size: "large",
  monthly_cents: 65000,
  cancellation_policy: "full_before_start",
  policy_confirmed: true,
  revision: 4,
  availability: [{ starts_on: "2026-10-04", ends_on: "2027-01-04", status: "confirmed", hold_until: hold }],
};
const coruscant: Studio = {
  ...paris,
  id: 4,
  name: "Coruscant",
  size: "medium",
  monthly_cents: 40000,
  availability: [{ starts_on: "2026-11-01", ends_on: "2026-12-01", status: "pending", hold_until: hold }],
};
const bigApple: Studio = { ...paris, id: 8, name: "Big Apple", monthly_cents: null, policy_confirmed: false, availability: [] };
const base = {
  amount_cents: 40000,
  refund_cents: 0,
  hold_until: hold,
  cancellation_policy: "full_before_start",
  payment_method: "manual",
};
const rentals: Rental[] = [
  { ...base, id: 21, name: "Coruscant", studio_id: 4, userid: 31, member_name: "Priya Nair", email: "priya@example.com", starts_on: "2026-11-01", ends_on: "2026-12-01", status: "pending", payment_status: "unpaid" },
  { ...base, id: 22, name: "Paris", studio_id: 7, userid: 32, member_name: "Lena Ortiz", email: "lena@example.com", starts_on: "2026-10-04", ends_on: "2027-01-04", amount_cents: 65000, status: "confirmed", payment_status: "paid", payment_method: "stripe_test" },
  { ...base, id: 23, name: "Alderaan", studio_id: 5, userid: 33, member_name: "Jordan Ames", starts_on: "2026-12-10", ends_on: "2027-01-10", status: "cancelled", payment_status: "refund_failed", payment_method: "stripe_test", refund_cents: 40000, refund_id: "re_1" },
];

function serve(studios: Studio[] = [paris, coruscant, bigApple], list: Rental[] = rentals) {
  api.mockImplementation((path: string) => {
    if (path === "/config") return Promise.resolve({ timeZone: "America/New_York" });
    if (path === "/studios") return Promise.resolve({ studios });
    if (path === "/studio-management/rentals") return Promise.resolve(list);
    return Promise.resolve({});
  });
}
const show = () => render(<MemoryRouter><StaffStudios /></MemoryRouter>);
const calls = (path: string) => api.mock.calls.filter(([p]) => p === path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T16:00:00Z"));
  auth.user = { roles: ["staff"] };
  serve();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

test("new holds show up when staff come back to the tab", async () => {
  serve([], []);
  show();
  await screen.findByText(/Nothing waiting/);
  expect(calls("/studio-management/rentals")).toHaveLength(1);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(calls("/studio-management/rentals")).toHaveLength(2));
});

test("staff record a desk payment with its receipt number right in the queue", async () => {
  show();
  const queue = await screen.findByRole("region", { name: "Needs you" });
  const row = within(queue).getByText("Collect from Priya Nair").closest("li")!;
  expect(within(row).getByText(/hold ends Fri, Oct 30/)).toBeTruthy();
  expect(within(row).getByText("$400.00")).toBeTruthy();
  fireEvent.change(within(row).getByLabelText("Receipt or check number for Priya Nair"), { target: { value: " 4471 " } });
  fireEvent.submit(within(row).getByLabelText("Receipt or check number for Priya Nair").closest("form")!);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/studio-management/rentals/21/payment", { method: "POST", body: { reference: "4471" } }),
  );
  expect((await screen.findByRole("status")).textContent).toBe("Payment recorded. Coruscant is booked for Priya Nair.");
});

test("a failed card refund sits in the same queue with a retry", async () => {
  show();
  const queue = await screen.findByRole("region", { name: "Needs you" });
  const row = within(queue).getByText("Card refund failed for Jordan Ames").closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Recheck refund" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/studio-management/rentals/23/retry-refund", { method: "POST", body: {} }),
  );
});

test("the board says who has each studio and opens its sheet", async () => {
  show();
  const board = await screen.findByRole("region", { name: "Occupancy" });
  expect(within(board).getByText("Lena Ortiz · through Jan 3")).toBeTruthy();
  expect(within(board).getByText("Open now · held from Nov 1")).toBeTruthy();
  expect(within(board).getByText("Not offered to members")).toBeTruthy();
  expect(within(board).queryByRole("button", { name: "Set rate" })).toBeNull();
  fireEvent.click(within(board).getByRole("button", { name: /^Paris/ }));
  const sheet = screen.getByRole("dialog", { name: "Paris" });
  expect(within(sheet).getByText("lena@example.com")).toBeTruthy();
  expect(within(sheet).getByText("$650.00 · card")).toBeTruthy();
  expect(within(sheet).getByText("Open from Mon, Jan 4.")).toBeTruthy();
  // Rates and terms are for admins only.
  expect(within(sheet).queryByRole("button", { name: "Edit" })).toBeNull();
});

test("admins change a rate and only confirm approval once something changed", async () => {
  auth.user = { roles: ["admin"] };
  show();
  fireEvent.click(await screen.findByRole("button", { name: /^Paris/ }));
  const sheet = screen.getByRole("dialog", { name: "Paris" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Edit" }));
  const save = within(sheet).getByRole("button", { name: "Save rate and terms" }) as HTMLButtonElement;
  expect(within(sheet).queryByRole("checkbox")).toBeNull();
  expect(save.disabled).toBe(true);
  fireEvent.change(within(sheet).getByLabelText("Monthly rate"), { target: { value: "700" } });
  fireEvent.click(within(sheet).getByRole("radio", { name: /No refunds/ }));
  expect(within(sheet).getByText(/New bookings pay \$700\.00\. The current rental keeps/)).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.click(within(sheet).getByRole("checkbox", { name: /approved this rate/ }));
  fireEvent.submit(save.closest("form")!);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/studio-management/studios/7", {
      method: "PATCH",
      body: { monthlyCents: 70000, cancellationPolicy: "no_refunds", policyConfirmed: true, revision: 4 },
    }),
  );
});

test("a studio without terms opens straight into the rate form for admins", async () => {
  auth.user = { roles: ["admin"] };
  show();
  const board = await screen.findByRole("region", { name: "Occupancy" });
  fireEvent.click(within(board).getByRole("button", { name: "Set rate" }));
  const sheet = screen.getByRole("dialog", { name: "Big Apple" });
  expect(within(sheet).getByLabelText("Monthly rate")).toBeTruthy();
  expect(within(sheet).getByText("Saving offers Big Apple to members at this rate.")).toBeTruthy();
});
