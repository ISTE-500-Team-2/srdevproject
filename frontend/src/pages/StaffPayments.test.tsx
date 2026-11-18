// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StaffPayments } from "./StaffPayments";
import { useApi } from "../lib/useApi";
import { api } from "../lib/api";
import type { Payment, PaymentPage } from "../lib/staffContracts";

vi.mock("../lib/useApi", () => ({ useApi: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), api: vi.fn() }));
vi.mock("../components/MemberSelect", () => ({ MemberSelect: () => <div>Member filter</div> }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

const base = {
  userId: 41,
  membershipId: 1,
  dayPassId: null,
  revision: 1,
  recordedAt: "2026-11-10T18:03:00Z",
  updatedAt: "2026-11-10T18:03:00Z",
  planName: "Monthly membership",
  reference: "",
  invoiceId: null,
  refundStatus: null,
};
const desk = { ...base, id: 212, memberName: "Jordan Lee", amount: "45.00", status: "pending", method: "unspecified" } as Payment;
const card = { ...base, id: 209, memberName: "Chris Walker", amount: "45.00", status: "paid", method: "card", invoiceId: "in_1" } as Payment;
const refunding = { ...card, id: 208, memberName: "Morgan Diaz", invoiceId: "in_2", refundStatus: "pending" } as Payment;
const reload = vi.fn();
const mount = (items: Payment[]) => {
  const data: PaymentPage = {
    items,
    nextOffset: null,
    summary: { count: items.length, collected: "90.00", pendingCount: 1, pending: "45.00", refunded: "0" },
  };
  vi.mocked(useApi).mockReturnValue({ data, loading: false, refreshing: false, error: "", reload } as never);
  render(<StaffPayments />);
};

test("saving a payment keeps the table on screen and confirms on the page", async () => {
  vi.mocked(api).mockResolvedValue({} as never);
  mount([desk, card]);
  expect(vi.mocked(useApi).mock.calls.find(([path]) => path?.startsWith("/admin/payments"))?.[1]).toEqual({ retainOnReload: true, retainOnChange: true });
  fireEvent.click(screen.getByRole("button", { name: "Update payment #212 for Jordan Lee" }));
  const form = screen.getByRole("form", { name: "Update payment #212" });
  fireEvent.change(within(form).getByLabelText("Payment method"), { target: { value: "cash" } });
  fireEvent.change(within(form).getByLabelText("Reason for change"), { target: { value: "Paid at desk" } });
  fireEvent.submit(form);
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith("/admin/payments/212/status", {
    method: "POST",
    body: { status: "paid", method: "cash", reference: "", reason: "Paid at desk", revision: 1 },
  });
  expect(screen.getByRole("status").textContent).toBe("Payment #212 for Jordan Lee is now paid.");
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByText("Chris Walker")).toBeTruthy();
  // Keyboard users land back on the row they were working in.
  await waitFor(() => expect(document.activeElement?.id).toBe("payment-212-action"));
});

test("another page keeps the current results in place and out of reach, the pager keeps focus, and focus moves to the new page when it lands", () => {
  const summary = { count: 60, collected: "90.00", pendingCount: 1, pending: "45.00", refunded: "0" };
  const first: PaymentPage = { items: [desk, card], nextOffset: 50, summary };
  const second: PaymentPage = { items: [refunding], nextOffset: null, summary };
  const read = (data: PaymentPage, stale: boolean) =>
    vi.mocked(useApi).mockReturnValue({ data, loading: false, refreshing: stale, stale, error: "", reload } as never);
  read(first, false);
  const { rerender } = render(<StaffPayments />);
  const results = () => document.querySelector(".kept-results")!;
  const next = () => screen.getByRole("button", { name: "Next page" });
  expect(results().hasAttribute("inert")).toBe(false);
  expect(results().hasAttribute("aria-busy")).toBe(false);

  // The next page is on its way: the hook keeps the last page and reports it as stale.
  read(first, true);
  next().focus();
  fireEvent.click(next());
  expect(vi.mocked(useApi).mock.lastCall?.[0]).toContain("offset=50");
  // Old rows can't be used, so nobody edits a row that may vanish...
  expect(results().hasAttribute("inert")).toBe(true);
  expect(results().getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("Jordan Lee")).toBeTruthy();
  expect(screen.queryByText("Loading records…")).toBeNull();
  // ...but the pager sits outside them: the button pressed keeps focus, and does nothing until the page lands.
  expect(results().contains(next())).toBe(false);
  expect(document.activeElement).toBe(next());
  expect(next().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(next());
  expect(vi.mocked(useApi).mock.calls.some(([path]) => path?.includes("offset=100"))).toBe(false);

  // The page lands: focus moves to the top of the new results.
  read(second, false);
  rerender(<StaffPayments />);
  expect(screen.getByText("Morgan Diaz")).toBeTruthy();
  expect(results().hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(results());
});

test("refreshing the same results after a save leaves them usable and not busy", () => {
  vi.mocked(useApi).mockReturnValue({
    data: { items: [desk], nextOffset: null, summary: { count: 1, collected: "0", pendingCount: 1, pending: "45.00", refunded: "0" } },
    loading: false,
    refreshing: true,
    stale: false,
    error: "",
    reload,
  } as never);
  render(<StaffPayments />);
  const results = document.querySelector(".kept-results")!;
  expect(results.contains(screen.getByText("Jordan Lee"))).toBe(true);
  expect(results.hasAttribute("aria-busy")).toBe(false);
  expect(results.hasAttribute("inert")).toBe(false);
});

test("a card refund needs explicit confirmation and isn't offered while one is pending", async () => {
  vi.mocked(api).mockResolvedValue({ status: "succeeded" } as never);
  mount([card, refunding]);
  expect(screen.getByText("Refund pending")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /payment #208/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refund payment #209 for Chris Walker" }));
  const form = screen.getByRole("form", { name: "Refund $45.00 to Chris Walker's card" });
  fireEvent.change(within(form).getByLabelText("Reason for refund"), { target: { value: "Cancelled in first week" } });
  const confirm = within(form).getByRole("checkbox", { name: /Refund \$45.00 to Chris Walker/ }) as HTMLInputElement;
  expect(confirm.required).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Refund $45.00" }));
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  fireEvent.click(within(form).getByRole("button", { name: "Refund $45.00" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/billing-management/invoices/in_1/refund", {
      method: "POST",
      body: { reason: "Cancelled in first week" },
    }),
  );
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Refunded $45.00 to Chris Walker's card."));
  // The row has no action any more, so focus goes to the table.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Payments" })));
});

test("a card refund Stripe didn't complete is an alert, not the green confirmation", async () => {
  vi.mocked(api).mockResolvedValue({ status: "failed" } as never);
  mount([card]);
  fireEvent.click(screen.getByRole("button", { name: "Refund payment #209 for Chris Walker" }));
  const form = screen.getByRole("form", { name: "Refund $45.00 to Chris Walker's card" });
  fireEvent.change(within(form).getByLabelText("Reason for refund"), { target: { value: "Cancelled in first week" } });
  fireEvent.click(within(form).getByRole("checkbox", { name: /Refund \$45.00 to Chris Walker/ }));
  fireEvent.click(within(form).getByRole("button", { name: "Refund $45.00" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Stripe didn't complete the refund to Chris Walker's card. Check it in Stripe.");
  expect(alert.className).toBe("payments__notice payments__notice--problem");
  expect(screen.queryByRole("status")).toBeNull();
});

test("a failed refund isn't offered again; staff are pointed to Stripe", () => {
  mount([{ ...card, refundStatus: "failed" } as Payment]);
  expect(screen.getByText("Refund failed")).toBeTruthy();
  expect(screen.getByText("Check this refund in Stripe.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /payment #209/ })).toBeNull();
});

test("filters reach the request and the totals cover the filtered set", () => {
  mount([desk]);
  expect(screen.getByText("Awaiting payment").nextElementSibling?.textContent).toContain("$45.00");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "pending" } });
  expect(vi.mocked(useApi).mock.lastCall?.[0]).toBe("/admin/payments?offset=0&status=pending");
});

/** Payments at `now`, with /config answering `config` (a zone, still loading, or failed). */
function mountAt(now: string, config: { timeZone: string } | "loading" | "failed") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const data: PaymentPage = { items: [], nextOffset: null, summary: { count: 0, collected: "0", pendingCount: 0, pending: "0", refunded: "0" } };
  vi.mocked(useApi).mockImplementation(((path: string) =>
    path === "/config"
      ? { data: typeof config === "object" ? config : null, loading: config === "loading", refreshing: false, error: config === "failed" ? "Offline" : "", reload }
      : { data, loading: false, refreshing: false, error: "", reload }) as never);
  render(<StaffPayments />);
}
const fromFor = (period: string) => {
  fireEvent.change(screen.getByLabelText("Period"), { target: { value: period } });
  return new URL(vi.mocked(useApi).mock.lastCall?.[0] as string, "http://x").searchParams.get("from");
};

test("periods start at midnight in the facility's time zone, not the browser's", () => {
  // 03:00 UTC on Nov 11 is already 4 pm on Nov 11 in Auckland (UTC+13).
  mountAt("2026-11-11T03:00:00Z", { timeZone: "Pacific/Auckland" });
  expect(fromFor("today")).toBe("2026-11-10T11:00:00.000Z");
  expect(fromFor("7d")).toBe("2026-11-04T11:00:00.000Z");
  expect(fromFor("30d")).toBe("2026-10-12T11:00:00.000Z");
  expect(fromFor("month")).toBe("2026-10-31T11:00:00.000Z");
  expect(fromFor("all")).toBeNull();
});

test("the period filter waits for the facility zone, and falls back to New York when it can't be read", () => {
  mountAt("2026-11-11T03:00:00Z", "loading");
  expect((screen.getByLabelText("Period") as HTMLSelectElement).disabled).toBe(true);
  cleanup();
  mountAt("2026-11-11T03:00:00Z", "failed");
  expect((screen.getByLabelText("Period") as HTMLSelectElement).disabled).toBe(false);
  // Still Nov 10 in New York (UTC-5).
  expect(fromFor("today")).toBe("2026-11-10T05:00:00.000Z");
});

test("an open page's \"Today\" and \"This month\" move on at the facility's midnight, and nothing refetches before then", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  // 11:50 PM on Nov 30 in New York.
  vi.setSystemTime(new Date("2026-12-01T04:50:00Z"));
  const data: PaymentPage = { items: [], nextOffset: null, summary: { count: 0, collected: "0", pendingCount: 0, pending: "0", refunded: "0" } };
  vi.mocked(useApi).mockImplementation(((path: string) =>
    path === "/config"
      ? { data: { timeZone: "America/New_York" }, loading: false, refreshing: false, error: "", reload }
      : { data, loading: false, refreshing: false, error: "", reload }) as never);
  render(<StaffPayments />);
  const paths = () => vi.mocked(useApi).mock.calls.map(([path]) => path).filter((path) => path?.startsWith("/admin/payments"));
  const from = () => new URL(paths().at(-1)!, "http://x").searchParams.get("from");

  expect(fromFor("today")).toBe("2026-11-30T05:00:00.000Z");
  const asked = new Set(paths());
  act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(new Set(paths())).toEqual(asked);
  act(() => vi.advanceTimersByTime(10 * 60_000));
  expect(from()).toBe("2026-12-01T05:00:00.000Z");

  cleanup();
  // "This month", picked late on Nov 30, moves to December after midnight.
  vi.setSystemTime(new Date("2026-12-01T04:50:00Z"));
  render(<StaffPayments />);
  expect(fromFor("month")).toBe("2026-11-01T04:00:00.000Z");
  act(() => vi.advanceTimersByTime(15 * 60_000));
  expect(from()).toBe("2026-12-01T05:00:00.000Z");
});

test("when a saved payment leaves the filtered results, focus lands on the confirmation", async () => {
  vi.mocked(api).mockResolvedValue({} as never);
  const page = (items: Payment[]): PaymentPage => ({
    items,
    nextOffset: null,
    summary: { count: items.length, collected: "0", pendingCount: items.length, pending: "45.00", refunded: "0" },
  });
  vi.mocked(useApi).mockReturnValue({ data: page([desk]), loading: false, refreshing: false, error: "", reload } as never);
  const view = render(<StaffPayments />);
  fireEvent.click(screen.getByRole("button", { name: "Update payment #212 for Jordan Lee" }));
  const form = screen.getByRole("form", { name: "Update payment #212" });
  fireEvent.change(within(form).getByLabelText("Reason for change"), { target: { value: "Paid at desk" } });
  fireEvent.submit(form);
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  // The refreshed "Pending" results no longer include it.
  vi.mocked(useApi).mockReturnValue({ data: page([]), loading: false, refreshing: false, error: "", reload } as never);
  view.rerender(<StaffPayments />);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(screen.queryByRole("region", { name: "Payments" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
});

test("clearing filters from an empty result hands focus to the filters before the results wait on the change", () => {
  mount([]);
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "void" } });
  const clear = screen.getByRole("button", { name: "Clear filters" });
  clear.focus();
  fireEvent.click(clear);
  expect(document.activeElement).toBe(screen.getByRole("group", { name: "Filter payments" }));
  expect(vi.mocked(useApi).mock.lastCall?.[0]).not.toContain("status=");
});

test("when \"Today\" moves on at midnight, the new day starts from its first page", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-12-01T04:50:00Z")); // 11:50 PM on Nov 30 in New York
  const data: PaymentPage = { items: [desk], nextOffset: 50, summary: { count: 140, collected: "0", pendingCount: 1, pending: "45.00", refunded: "0" } };
  vi.mocked(useApi).mockImplementation(((path: string) =>
    path === "/config"
      ? { data: { timeZone: "America/New_York" }, loading: false, refreshing: false, error: "", reload }
      : { data, loading: false, refreshing: false, error: "", reload }) as never);
  render(<StaffPayments />);
  const last = () => new URL(vi.mocked(useApi).mock.calls.map(([path]) => path).filter((path) => path?.startsWith("/admin/payments")).at(-1)!, "http://x").searchParams;
  fireEvent.change(screen.getByLabelText("Period"), { target: { value: "today" } });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(last().get("offset")).toBe("50");
  act(() => vi.advanceTimersByTime(15 * 60_000));
  expect(last().get("from")).toBe("2026-12-01T05:00:00.000Z");
  expect(last().get("offset")).toBe("0");
});

test("the page says studio rentals are kept on the Studios page, not in this list or its totals", () => {
  mount([desk]);
  expect(document.querySelector(".payments__intro")?.textContent).toMatch(
    /Studio\s+rentals are paid and refunded on the Studios page, so they aren't in this list or its totals\./,
  );
});
