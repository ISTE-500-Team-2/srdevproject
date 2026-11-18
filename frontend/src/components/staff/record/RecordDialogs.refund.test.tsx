// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordDialogHost } from "./RecordDialogs";
import type { Payment, Person } from "../../../lib/staffContracts";

const { api, useApi } = vi.hoisted(() => ({ api: vi.fn(), useApi: vi.fn() }));
vi.mock("../../../lib/api", async (original) => ({ ...(await original<typeof import("../../../lib/api")>()), api }));
vi.mock("../../../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const payment: Payment = {
  id: 7, userId: 3, memberName: "Ada Lovelace", membershipId: 2, dayPassId: null, amount: "50.00", status: "paid",
  method: "card", reference: "", revision: 1, recordedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z",
  planName: "Monthly", invoiceId: "in_test", refundStatus: null,
};

async function refund(status: string) {
  useApi.mockReturnValue({ data: null, loading: false, refreshing: false, error: "", reload: vi.fn() });
  api.mockResolvedValue({ status });
  const onDone = vi.fn();
  render(
    <RecordDialogHost
      dialog={{ kind: "refund", payment }}
      person={{ id: 3, firstName: "Ada", revision: 1 } as Person}
      plans={[]}
      timeZone="America/New_York"
      supervision={null}
      onClose={vi.fn()}
      onDone={onDone}
      onPerson={vi.fn()}
      onConflict={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Reason for refund/), { target: { value: "Duplicate charge" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Refund $50.00" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledWith("/billing-management/invoices/in_test/refund", { method: "POST", body: { reason: "Duplicate charge" } });
  // The sentence, and whether it reports a problem (shown as an alert, not a green confirmation).
  return onDone.mock.calls[0] as [string, boolean];
}

test("a succeeded card refund says it was refunded", async () => {
  expect(await refund("succeeded")).toEqual(["Refunded $50.00.", false]);
});

test.each(["pending", "requires_action"])("a %s card refund says it is on its way", async (status) => {
  expect(await refund(status)).toEqual(["Refund of $50.00 is on its way.", false]);
});

test.each(["failed", "canceled", "unexpected"])("a %s card refund does not claim money moved and is reported as a problem", async (status) => {
  expect(await refund(status)).toEqual(["Stripe didn't complete the refund of $50.00. Check it in Stripe.", true]);
});
