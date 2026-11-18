// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Payment } from "../../lib/staffContracts";
import { cardRefundPath, paymentAction, paymentMethodName } from "./PaymentControls";
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

const card = {
  id: 77, userId: 41, membershipId: null, dayPassId: null, revision: 1, memberName: "Jordan Lee", amount: "14.00", status: "paid",
  method: "card", recordedAt: "2026-11-10T18:03:00Z", updatedAt: "2026-11-10T18:03:00Z", reference: "cs_1", invoiceId: null,
  passCheckoutId: null, equipmentReservationId: null, refundStatus: null,
} as Payment;

test("card day passes and equipment bookings are refunded through their own checkout", () => {
  const pass = { ...card, passCheckoutId: "8d0f4c1e-1111-4222-8333-944445555666" };
  const booking = { ...card, equipmentReservationId: 31 };
  expect(cardRefundPath(card)).toBeNull();
  expect(paymentAction(card)).toBeNull();
  expect(cardRefundPath(pass)).toBe("/billing-management/passes/8d0f4c1e-1111-4222-8333-944445555666/refund");
  expect(cardRefundPath(booking)).toBe("/billing-management/equipment/31/refund");
  for (const payment of [pass, booking]) {
    expect(paymentAction(payment)).toBe("refund");
    expect(paymentAction({ ...payment, refundStatus: "pending" })).toBeNull();
    expect(paymentAction({ ...payment, status: "refunded", refundStatus: "succeeded" })).toBeNull();
  }
});

test.each([
  ["equipment booking", { equipmentReservationId: 31, planName: "Equipment: Laser (cancelled; refund due)" }, "/billing-management/equipment/31/refund", /booking itself doesn't change/],
  ["day pass", { passCheckoutId: "pass-1", planName: "Day pass" }, "/billing-management/passes/pass-1/refund", /day pass is cancelled once the refund goes through/],
])("a card %s can be refunded from the payments list", async (_kind, extra, path, effect) => {
  api.mockResolvedValue({ status: "succeeded" });
  const onChanged = vi.fn();
  const payment = { ...card, ...extra } as Payment;
  const { rerender } = render(<PaymentTable items={[payment]} caption="Payments" open={null} onOpen={() => undefined} onChanged={onChanged} />);
  expect(screen.getByRole("button", { name: "Refund payment #77 for Jordan Lee" })).toBeTruthy();
  rerender(<PaymentTable items={[payment]} caption="Payments" open={77} onOpen={() => undefined} onChanged={onChanged} />);
  const form = screen.getByRole("form", { name: "Refund $14.00 to Jordan Lee's card" });
  expect(form.textContent).toMatch(effect);
  fireEvent.change(within(form).getByLabelText("Reason for refund"), { target: { value: "Cancelled booking" } });
  fireEvent.click(within(form).getByRole("checkbox"));
  fireEvent.click(within(form).getByRole("button", { name: "Refund $14.00" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith("Refunded $14.00 to Jordan Lee's card.", false));
  expect(api).toHaveBeenCalledWith(path, { method: "POST", body: { reason: "Cancelled booking" } });
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
