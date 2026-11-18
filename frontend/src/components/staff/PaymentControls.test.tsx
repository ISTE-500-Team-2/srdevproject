// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Payment } from "../../lib/staffContracts";
import { paymentMethodName } from "./PaymentControls";
import { PaymentTable } from "./PaymentTable";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({ ...(await original<typeof import("../../lib/api")>()), api }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("free plans read \"No charge\", not the raw method \"none\"", () => {
  expect(paymentMethodName("none")).toBe("No charge");
  const free = {
    id: 42, userId: 41, membershipId: 9, dayPassId: null, revision: 1, memberName: "Jordan Lee", amount: "0.00", status: "waived", method: "none",
    recordedAt: "2026-11-10T18:03:00Z", updatedAt: "2026-11-10T18:03:00Z", planName: "Monthly membership", reference: "free-membership:9", invoiceId: null, refundStatus: null,
  } as Payment;
  render(<PaymentTable items={[free]} caption="Payments" open={null} onOpen={() => undefined} onChanged={() => undefined} />);
  expect(screen.getByText("No charge")).toBeTruthy();
  expect(screen.queryByText("none")).toBeNull();
});

test.each([
  ["succeeded", "Refunded $50.00 to Ada Lovelace's card.", false],
  ["pending", "Refund of $50.00 to Ada Lovelace's card is on its way.", false],
  ["failed", "Stripe didn't complete the refund to Ada Lovelace's card. Check it in Stripe.", true],
  ["canceled", "Stripe didn't complete the refund to Ada Lovelace's card. Check it in Stripe.", true],
])("a %s card refund from the Payments table is reported with the right tone", async (status, message, problem) => {
  const card = {
    id: 7, userId: 3, memberName: "Ada Lovelace", membershipId: 2, dayPassId: null, amount: "50.00", status: "paid", method: "card",
    reference: "", revision: 1, recordedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", planName: "Monthly",
    invoiceId: "in_test", refundStatus: null,
  } as Payment;
  api.mockResolvedValue({ status });
  const onChanged = vi.fn();
  render(<PaymentTable items={[card]} caption="Payments" open={7} onOpen={() => undefined} onChanged={onChanged} />);
  fireEvent.change(screen.getByLabelText(/Reason for refund/), { target: { value: "Duplicate charge" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Refund $50.00" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(message, problem));
});
