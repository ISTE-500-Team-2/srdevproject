// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Payment } from "../../lib/staffContracts";
import { paymentMethodName } from "./PaymentControls";
import { PaymentTable } from "./PaymentTable";

afterEach(cleanup);

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

test("a booking payment still in online checkout has no Update action and says why", () => {
  const held = {
    id: 43, userId: 41, membershipId: null, dayPassId: null, revision: 1, memberName: "Jordan Lee", amount: "40.00", status: "pending", method: "unspecified",
    recordedAt: "2026-11-10T18:03:00Z", updatedAt: "2026-11-10T18:03:00Z", planName: "Equipment: Laser", reference: "", invoiceId: null, refundStatus: null, onlineCheckout: true,
  } as Payment;
  render(<PaymentTable items={[held, { ...held, id: 44, onlineCheckout: false }]} caption="Payments" open={null} onOpen={() => undefined} onChanged={() => undefined} />);
  expect(screen.getAllByText("Paid by card online: the member pays through checkout, or cancel the reservation.")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /payment #43/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Update payment #44 for Jordan Lee" })).toBeTruthy();
});
