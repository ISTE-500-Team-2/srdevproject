// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Payment } from "../../lib/staffContracts";
import { CardRefund } from "./PaymentControls";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const payment = {
  id: 44, userId: 41, membershipId: 9, dayPassId: null, revision: 1, memberName: "Jordan Lee", amount: "50.00", status: "paid", method: "card",
  recordedAt: "2026-11-10T18:03:00Z", updatedAt: "2026-11-10T18:03:00Z", planName: "Monthly membership", reference: "in_1", invoiceId: "in_1", refundStatus: null,
} as Payment;
const mount = (stripeMode?: "test" | "live") => {
  useApi.mockImplementation((path: string) => ({ data: path === "/config" && stripeMode ? { timeZone: "America/New_York", stripeMode } : null,
    loading: false, refreshing: false, error: "", reload: vi.fn() }));
  render(<CardRefund payment={payment} onRefunded={() => undefined} />);
};

test("the card refund says no real money moves only in test mode", () => {
  mount("test");
  expect(useApi).toHaveBeenCalledWith("/config", { reuse: true });
  expect(screen.getByText(/The full payment goes back to the card it was paid with\..*Stripe is in test mode, so no real money moves\./)).toBeTruthy();
});

test.each([["live"], [undefined]] as const)("in %s mode the card refund makes no test-mode claim", (mode) => {
  mount(mode);
  expect(screen.getByText(/The full payment goes back to the card it was paid with\./)).toBeTruthy();
  expect(screen.queryByText(/test mode|no real money/)).toBeNull();
});
