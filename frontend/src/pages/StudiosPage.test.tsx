// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StudiosPage } from "./StudiosPage";
import type { Studio } from "../lib/studioContracts";

const { api, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { roles: ["member"], membership: "Monthly" } as unknown },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: Error) => error.message,
}));

const studio = (id: number, name: string, availability: Studio["availability"] = []): Studio => ({
  id,
  name,
  size: "small",
  monthly_cents: 35000,
  cancellation_policy: "full_before_start",
  policy_confirmed: true,
  revision: 1,
  availability,
});
let studios: Studio[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-10T15:00:00Z"));
  studios = [studio(1, "Harkonnen"), studio(2, "Atreides")];
  api.mockImplementation((path: string) => {
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    return Promise.resolve([]);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  auth.user = { roles: ["member"], membership: "Monthly" };
});

function mount() {
  return render(
    <MemoryRouter>
      <StudiosPage />
    </MemoryRouter>,
  );
}
async function openSmall() {
  fireEvent.click(await screen.findByRole("button", { name: /^Small studios/ }));
  return screen.getByRole("dialog", { name: "Reserve a small studio" });
}
const calls = (path: string) =>
  api.mock.calls.filter(([p]) => p === path).length;

test("the member page never loads the staff studio desk", async () => {
  auth.user = { roles: ["staff"], membership: "None" };
  mount();
  await screen.findByRole("button", { name: /^Small studios/ });
  expect(calls("/studio-management/rentals")).toBe(0);
  expect(screen.queryByRole("heading", { name: /Studio desk|Payments to record/ })).toBeNull();
});

test("a changed booking gets a new request key; an identical retry reuses it", async () => {
  mount();
  const dialog = await openSmall();
  const keys: string[] = [];
  api.mockImplementation((path: string, init?: { body?: { requestKey: string } }) => {
    if (path === "/studio-rentals" && init?.body) {
      keys.push(init.body.requestKey);
      return Promise.reject(new Error("Network error"));
    }
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    return Promise.resolve([]);
  });
  const hold = within(dialog).getByRole("button", { name: "Hold studio" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Sun, Jan 20, 2030" }));
  fireEvent.click(hold);
  await within(dialog).findByText("Network error");
  fireEvent.click(hold);
  await waitFor(() => expect(keys).toHaveLength(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "Mon, Jan 21, 2030" }));
  fireEvent.click(hold);
  await waitFor(() => expect(keys).toHaveLength(3));
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

test("a studio taken while the pop-up is open can't be submitted", async () => {
  mount();
  const dialog = await openSmall();
  fireEvent.click(within(dialog).getByRole("button", { name: "Sun, Jan 20, 2030" }));
  const hold = within(dialog).getByRole("button", { name: "Hold studio" });
  expect((hold as HTMLButtonElement).disabled).toBe(false);
  // Someone else books Harkonnen; the next background refresh picks it up.
  studios = [
    studio(1, "Harkonnen", [
      { starts_on: "2030-01-15", ends_on: "2030-02-15", status: "confirmed", hold_until: "" },
    ]),
    studio(2, "Atreides"),
  ];
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await within(dialog).findByText(
    "Harkonnen was just taken for these dates. Pick another studio.",
  );
  expect((hold as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("radio", { name: /Atreides/ }));
  expect((hold as HTMLButtonElement).disabled).toBe(false);
});

const rental = (over: Record<string, unknown>) => ({
  id: 7,
  name: "Harkonnen",
  starts_on: "2030-01-20",
  ends_on: "2030-02-20",
  amount_cents: 35000,
  status: "confirmed",
  payment_status: "paid",
  payment_method: "manual",
  hold_until: "",
  refund_cents: 0,
  cancellation_policy: "full_before_start",
  ...over,
});
function withRentals(rentals: unknown[]) {
  api.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    if (path === "/studio-rentals") return Promise.resolve(rentals);
    if (init?.method) return Promise.resolve({});
    return Promise.resolve([]);
  });
}

test("cancelling a rental explains the refund in a dialog, not a browser pop-up", async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const confirm = vi.spyOn(window, "confirm");
  withRentals([rental({})]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel rental" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel Harkonnen?" });
  expect(within(dialog).getByText(/You'll get \$350\.00 back/)).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  const hold = within(dialog).getByRole("button", { name: /Hold to cancel rental/ });
  fireEvent.keyDown(hold, { key: " " });
  await waitFor(
    () =>
      expect(api.mock.calls.some(([p, o]) => p === "/studio-rentals/7/cancel" && o?.method === "POST")).toBe(true),
    { timeout: 2500 },
  );
});

test("an unpaid hold says there's nothing to refund instead of $0.00", async () => {
  withRentals([rental({ status: "pending", payment_status: "unpaid", hold_until: "2030-01-10T15:30:00Z" })]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel rental" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel Harkonnen?" });
  expect(within(dialog).getByText("You haven't paid for this hold, so there's nothing to refund.")).toBeTruthy();
  expect(within(dialog).queryByText(/\$0\.00/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep rental" }));
  expect(screen.queryByRole("dialog", { name: "Cancel Harkonnen?" })).toBeNull();
});
