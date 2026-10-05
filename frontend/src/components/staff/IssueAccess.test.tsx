// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { IssueAccess } from "./IssueAccess";
import { PaymentEditor } from "./PaymentControls";
import { api } from "../../lib/api";
import type { Plan, Payment } from "../../lib/staffContracts";
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  api: vi.fn(),
}));
const plan: Plan = {
  id: 7,
  name: "Monthly",
  kind: "membership",
  price: "50.00",
  months: 1,
  benefits: "Access",
  active: true,
  revision: 4,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fields() {
  fireEvent.change(screen.getByLabelText("Access plan"), {
    target: { value: "7" },
  });
  fireEvent.change(
    screen.getByLabelText("Membership starts (your local timezone)"),
    { target: { value: "2030-01-02T12:00" } },
  );
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Approved access" },
  });
}

test("failed identical access submissions retain their request id across rerenders; changed payload gets a fresh id", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Offline"));
  const props = {
    id: 42,
    plans: [plan],
    timeZone: "America/New_York",
    renewal: null,
    disabled: false,
    onSaved: vi.fn(),
  };
  const view = render(<IssueAccess {...props} />);
  fields();
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("alert");
  const first = vi.mocked(api).mock.calls[0]![1]!.body as Record<
    string,
    unknown
  >;
  expect(first).toMatchObject({
    planId: 7,
    validDate: null,
    paymentStatus: "pending",
    method: "unspecified",
    reference: "",
    reason: "Approved access",
  });
  expect(first.startsAt).toBe(new Date("2030-01-02T12:00").toISOString());
  expect(first.requestId).toEqual(expect.any(String));
  view.rerender(<IssueAccess {...props} plans={[{ ...plan }]} />);
  expect(
    (screen.getByLabelText("Reason for change") as HTMLInputElement).value,
  ).toBe("Approved access");
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  await screen.findByRole("alert");
  const second = vi.mocked(api).mock.calls[1]![1]!.body as Record<
    string,
    unknown
  >;
  expect(second).toEqual(first);
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Changed approval" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  const third = vi.mocked(api).mock.calls[2]![1]!.body as Record<
    string,
    unknown
  >;
  expect(third.requestId).not.toBe(first.requestId);
  expect(props.onSaved).not.toHaveBeenCalled();
});

test("successful access issuance clears the retry id for the next submission", async () => {
  vi.mocked(api).mockResolvedValue({});
  const saved = vi.fn();
  render(
    <IssueAccess
      id={42}
      plans={[plan]}
      timeZone="America/New_York"
      renewal={null}
      disabled={false}
      onSaved={saved}
    />,
  );
  fields();
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  await screen.findByRole("status");
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  const bodies = vi
    .mocked(api)
    .mock.calls.map((call) => call[1]!.body as { requestId: string });
  expect(bodies[1]!.requestId).not.toBe(bodies[0]!.requestId);
});

test("external payment updates retain their revision and request payload", async () => {
  vi.mocked(api).mockResolvedValue({});
  const saved = vi.fn();
  const payment = {
    id: 18,
    status: "pending",
    method: "cash",
    revision: 9,
    reference: "receipt-1",
  } as Payment;
  render(<PaymentEditor payment={payment} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Receipt verified" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith("/admin/payments/18/status", {
    method: "POST",
    body: {
      status: "paid",
      method: "cash",
      reference: "receipt-1",
      reason: "Receipt verified",
      revision: 9,
    },
  });
});

test("Stripe payments and terminal external statuses do not expose the external payment form", () => {
  const payment = { id: 18, status: "paid", method: "card" } as Payment;
  const view = render(<PaymentEditor payment={payment} onSaved={vi.fn()} />);
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByText(/Stripe-managed payment/)).toBeTruthy();
  view.rerender(
    <PaymentEditor
      payment={{ ...payment, method: "cash", status: "refunded" }}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByText(/status is final/)).toBeTruthy();
});
