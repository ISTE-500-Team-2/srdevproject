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
