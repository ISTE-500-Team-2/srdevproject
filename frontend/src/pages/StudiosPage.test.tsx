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

function mount(path = "/studios") {
  return render(
    <MemoryRouter initialEntries={[path]}>
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

const returned = "/studios?payment=returned&rental=7&session_id=cs_test_matching";

test("a checkout return cannot confirm an unrelated historical or manual payment", async () => {
  withRentals([rental({ id: 99, checkout_id: "cs_test_other" })]);
  mount(returned);
  await screen.findByRole("button", { name: /^Small studios/ });
  expect(screen.queryByText("Payment received.")).toBeNull();
  expect(screen.getByText(/couldn’t match this checkout return/)).toBeTruthy();
});

test("a matching paid card checkout confirms that rental even when another rental is newer or pending", async () => {
  withRentals([
    rental({ id: 99, name: "Unrelated", status: "pending", payment_status: "unpaid" }),
    rental({ checkout_id: "cs_test_matching", payment_method: "stripe_test" }),
  ]);
  mount(returned);
  await screen.findByText("Payment received.");
  expect(screen.getByText("Harkonnen is booked.", { exact: false })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Booking reference 000007" })).toBeTruthy();
});

test("a matching pending checkout stays pending rather than borrowing another paid rental", async () => {
  withRentals([
    rental({ id: 99, name: "Older paid rental", checkout_id: "cs_test_other", payment_method: "stripe_test" }),
    rental({ checkout_id: "cs_test_matching", payment_method: "stripe_test", status: "pending", payment_status: "unpaid" }),
  ]);
  mount(returned);
  await screen.findByText(/Checking your card payment/);
  expect(screen.queryByText("Payment received.")).toBeNull();
});

test("legacy or mismatched checkout returns never claim a new payment", async () => {
  withRentals([rental({ checkout_id: "cs_test_matching", payment_method: "stripe_test" })]);
  mount("/studios?payment=returned");
  await screen.findByText(/couldn’t match this checkout return/);
  expect(screen.queryByText("Payment received.")).toBeNull();
});


test("studio can be selected before a date, and the date preserves that choice", async () => {
 mount();
 const dialog = within(await openSmall());
 const atreides = dialog.getByRole('radio', {name: /Atreides/}) as HTMLInputElement;
 expect(atreides.disabled).toBe(false);
 fireEvent.click(atreides);
 expect(atreides.checked).toBe(true);
 expect((dialog.getByRole('button', {name: 'Hold studio'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(dialog.getByRole('button', {name: 'Sun, Jan 20, 2030'}));
 expect(atreides.checked).toBe(true);
 expect((dialog.getByRole('button', {name: 'Hold studio'}) as HTMLButtonElement).disabled).toBe(false);
});

test("unconfigured card checkout is visible with a reason and cannot be selected", async () => {
 mount();
 const dialog = within(await openSmall());
 expect((dialog.getByRole('radio', {name: /Pay now by card/}) as HTMLInputElement).disabled).toBe(true);
 expect(dialog.getByText('Not available right now. Pay at the front desk instead.')).toBeTruthy();
});

test("configured card checkout submits the selected studio and Stripe payment method", async () => {
 api.mockImplementation((path: string, init?: {body?: unknown}) => {
  if(path === '/studios') return Promise.resolve({studios,cardTestEnabled:true,timeZone:'UTC'});
  if(init?.body) return Promise.reject(new Error('Checkout request captured'));
  return Promise.resolve([]);
 });
 mount();
 const dialog = within(await openSmall());
 fireEvent.click(dialog.getByRole('radio',{name:/Atreides/}));
 fireEvent.click(dialog.getByRole('button',{name:'Sun, Jan 20, 2030'}));
 fireEvent.click(dialog.getByRole('radio',{name:/Pay now by card/}));
 fireEvent.click(dialog.getByRole('button',{name:'Continue to card payment'}));
 await dialog.findByText('Checkout request captured');
 const request=api.mock.calls.find(([path,init])=>path==='/studio-rentals' && init?.body);
 expect(request?.[1].body).toMatchObject({studioId:2,startDate:'2030-01-20',paymentMethod:'stripe_test'});
});

test("a finished month moves to past rentals and can't be cancelled", async () => {
  withRentals([
    rental({ id: 3, name: "Atreides", studio_id: 2, starts_on: "2029-11-01", ends_on: "2029-12-01", payment_method: "stripe_test" }),
    rental({ status: "pending", payment_status: "unpaid", hold_until: "2030-01-10T15:30:00Z" }),
  ]);
  mount();
  const current = await screen.findByRole("region", { name: "Your rentals" });
  expect(within(current).getByText("Harkonnen")).toBeTruthy();
  expect(within(current).queryByText("Atreides")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Cancel rental" })).toHaveLength(1);
  const past = screen.getByText("Past rentals (1)").closest("details")!;
  expect(within(past).getByText("Ended")).toBeTruthy();
  expect(within(past).getByText("Paid by card.")).toBeTruthy();
});

test("a failed first load says so and retries on its own, without a refresh button", async () => {
  let fail = true;
  api.mockImplementation((path: string) => {
    if (path === "/studios")
      return fail
        ? Promise.reject(new Error("Server unavailable."))
        : Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    return Promise.resolve([]);
  });
  mount();
  expect(screen.getByRole("status").textContent).toBe("Loading studios…");
  await screen.findByText(/Couldn’t load studios: Server unavailable\./);
  expect(screen.queryByRole("button", { name: /refresh|retry/i })).toBeNull();
  fail = false;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByRole("button", { name: /^Small studios/ });
  expect(screen.queryByText(/Couldn’t load studios/)).toBeNull();
});

test("size cards announce availability, not just price", async () => {
  mount();
  expect(
    await screen.findByRole("button", { name: "Small studios, $350.00 a month. 2 of 2 free today" }),
  ).toBeTruthy();
});

test("a front-desk hold confirms the dates, price and booking reference", async () => {
  api.mockImplementation((path: string, init?: { body?: unknown }) => {
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    if (path === "/studio-rentals" && init?.body)
      return Promise.resolve(rental({ id: 52, status: "pending", payment_status: "unpaid", hold_until: "2030-01-10T15:30:00Z" }));
    return Promise.resolve([]);
  });
  mount();
  const dialog = within(await openSmall());
  fireEvent.click(dialog.getByRole("button", { name: "Sun, Jan 20, 2030" }));
  fireEvent.click(dialog.getByRole("button", { name: "Hold studio" }));
  await dialog.findByText("Harkonnen is held for you");
  expect(dialog.getByText("Jan 20 – Feb 19, 2030 · $350.00")).toBeTruthy();
  expect(dialog.getByRole("group", { name: "Booking reference 000052" })).toBeTruthy();
});

test("a booking conflict reloads availability straight away", async () => {
  api.mockImplementation((path: string, init?: { body?: unknown }) => {
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    if (path === "/studio-rentals" && init?.body)
      return Promise.reject(new Error("Someone has already booked this studio."));
    return Promise.resolve([]);
  });
  mount();
  const dialog = within(await openSmall());
  const before = calls("/studios");
  fireEvent.click(dialog.getByRole("button", { name: "Sun, Jan 20, 2030" }));
  fireEvent.click(dialog.getByRole("button", { name: "Hold studio" }));
  await dialog.findByText("Someone has already booked this studio.");
  await waitFor(() => expect(calls("/studios")).toBeGreaterThan(before));
});

test("coming back from a still-pending card checkout asks the server to check it once", async () => {
  withRentals([rental({ checkout_id: "cs_test_matching", payment_method: "stripe_test", status: "pending", payment_status: "unpaid" })]);
  mount(returned);
  await screen.findByText(/Checking your card payment/);
  await waitFor(() =>
    expect(api.mock.calls.filter(([p, o]) => p === "/studio-rentals/7/payment-status" && o?.method === "POST")).toHaveLength(1),
  );
});

test("leaving card checkout explains the hold is kept", async () => {
  withRentals([rental({ payment_method: "stripe_test", status: "pending", payment_status: "unpaid", hold_until: "2030-01-10T15:30:00Z" })]);
  mount("/studios?payment=cancelled");
  expect(await screen.findByText(/You left card checkout before paying\. Harkonnen stays held until/)).toBeTruthy();
});
