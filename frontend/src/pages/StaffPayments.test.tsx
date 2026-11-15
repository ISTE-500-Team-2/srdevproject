// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  expect(vi.mocked(useApi).mock.calls.find(([path]) => path?.startsWith("/admin/payments"))?.[1]).toEqual({ retainOnReload: true });
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
