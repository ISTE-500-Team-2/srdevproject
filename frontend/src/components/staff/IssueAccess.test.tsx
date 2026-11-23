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
import { PaymentEditor, paymentAction } from "./PaymentControls";
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
/** The issuance requests, leaving out the price lookups the form makes on the way. */
const posts = () => vi.mocked(api).mock.calls.filter((call) => call[1]?.method === "POST");

const standardQuote = { planId: 7, standardCents: 5000, amountCents: 5000, basis: "standard" };
/** Price lookups answer with the standard price; issuance requests go to `post`. */
function mockApi(post: () => Promise<unknown>) {
  vi.mocked(api).mockImplementation(async (_path: string, init?: { method?: string }) =>
    init?.method === "POST" ? post() : standardQuote);
}
/** Issuing waits for the member's price to load. */
async function priceShown() {
  await screen.findByText("Price for this member: $50.00");
}

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
  mockApi(() => Promise.reject(new Error("Offline")));
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
  await priceShown();
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("alert");
  const first = posts()[0]![1]!.body as Record<
    string,
    unknown
  >;
  expect(first).toMatchObject({
    planId: 7,
    expectedAmountCents: 5000,
    validDate: null,
    paymentStatus: "paid",
    method: "cash",
    reference: "",
    reason: "Approved access",
  });
  expect(first.startsAt).toBe(new Date("2030-01-02T12:00").toISOString());
  expect(first.requestId).toEqual(expect.any(String));
  view.rerender(<IssueAccess {...props} plans={[{ ...plan }]} />);
  await priceShown();
  expect(
    (screen.getByLabelText("Reason for change") as HTMLInputElement).value,
  ).toBe("Approved access");
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(posts()).toHaveLength(2));
  await screen.findByRole("alert");
  const second = posts()[1]![1]!.body as Record<
    string,
    unknown
  >;
  expect(second).toEqual(first);
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Changed approval" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(posts()).toHaveLength(3));
  const third = posts()[2]![1]!.body as Record<
    string,
    unknown
  >;
  expect(third.requestId).not.toBe(first.requestId);
  expect(props.onSaved).not.toHaveBeenCalled();
});

test("successful access issuance clears the retry id for the next submission", async () => {
  mockApi(async () => ({}));
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
  await priceShown();
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  await screen.findByRole("status");
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  const bodies = posts().map((call) => call[1]!.body as { requestId: string });
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

test("only open front-desk records are editable; card payments offer a refund only before one was asked for", () => {
  const payment = { id: 18, status: "paid", method: "card", invoiceId: "in_1", refundStatus: null } as Payment;
  expect(paymentAction(payment)).toBe("refund");
  expect(paymentAction({ ...payment, invoiceId: null })).toBeNull();
  expect(paymentAction({ ...payment, refundStatus: "pending" })).toBeNull();
  expect(paymentAction({ ...payment, refundStatus: "failed" })).toBeNull();
  expect(paymentAction({ ...payment, status: "refunded", refundStatus: "succeeded" })).toBeNull();
  expect(paymentAction({ ...payment, method: "cash", status: "pending" })).toBe("update");
  expect(paymentAction({ ...payment, method: "cash", status: "paid" })).toBe("update");
  for (const status of ["refunded", "void", "waived"])
    expect(paymentAction({ ...payment, method: "cash", status })).toBeNull();
  // A booking still in its online card checkout is settled by the checkout, never at the desk.
  expect(paymentAction({ ...payment, method: "unspecified", status: "pending", invoiceId: null, onlineCheckout: true })).toBeNull();
  expect(paymentAction({ ...payment, method: "unspecified", status: "pending", invoiceId: null, onlineCheckout: false })).toBe("update");
});

test("B-003: the desk form shows the member's student price and promises exactly that price to the server", async () => {
  const saved = vi.fn();
  vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string }) =>
    init?.method === "POST" ? {} : path.startsWith("/admin/users/42/entitlements/quote?planId=7&startsAt=")
      ? { planId: 7, standardCents: 5000, amountCents: 3000, basis: "student" } : null);
  render(<IssueAccess id={42} plans={[plan]} timeZone="America/New_York" renewal={null} disabled={false} onSaved={saved} />);
  fields();
  expect(await screen.findByText("Price for this member: $30.00")).toBeTruthy();
  expect(screen.getByText(/Student price \(standard \$50\.00\)/)).toBeTruthy();
  expect(vi.mocked(api)).toHaveBeenCalledWith(
    `/admin/users/42/entitlements/quote?planId=7&startsAt=${encodeURIComponent(new Date("2030-01-02T12:00").toISOString())}`,
    expect.anything(),
  );
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(posts()[0]![1]!.body).toMatchObject({ planId: 7, paymentStatus: "paid", expectedAmountCents: 3000 });
});

test("B-003: nothing is issued until the member's price loads; a failed lookup can be retried", async () => {
  const saved = vi.fn();
  let quoteFails = true;
  vi.mocked(api).mockImplementation(async (_path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return {};
    if (quoteFails) throw new Error("Offline");
    return { planId: 7, standardCents: 5000, amountCents: 3000, basis: "student" };
  });
  render(<IssueAccess id={42} plans={[plan, { ...plan, id: 8, name: "Yearly", price: "500.00" }]} timeZone="America/New_York" renewal={null} disabled={false} onSaved={saved} />);
  fields();
  expect(await screen.findByText(/Couldn't load this member's price/)).toBeTruthy();
  const submit = screen.getByRole("button", { name: "Record payment and issue access" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form"));
  // Before a price is shown the plan list only offers standard prices, labelled as such.
  expect(screen.getByRole("option", { name: "Monthly · $50.00 standard" })).toBeTruthy();
  quoteFails = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Price for this member: $30.00")).toBeTruthy();
  expect(posts()).toHaveLength(0);
  // The chosen plan now lists this member's price; the others stay standard.
  expect(screen.getByRole("option", { name: "Monthly · $30.00" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Yearly · $500.00 standard" })).toBeTruthy();
  expect(submit.disabled).toBe(false);
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(posts()[0]![1]!.body).toMatchObject({ expectedAmountCents: 3000 });
});
