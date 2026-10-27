// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MembershipPage } from "./MembershipPage";
import { statusLabel } from "../lib/display";

const { api, reload, useApi } = vi.hoisted(() => ({ api: vi.fn(), reload: vi.fn(), useApi: vi.fn() }));
vi.mock("../lib/api", () => ({ api, errorMessage: (e: Error) => e.message }));
vi.mock("../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const monthly = { id: 1, name: "Monthly", kind: "membership" as const, price: "50.00", months: 1, benefits: "Open studio hours\nTool booking", active: true, revision: 2 };
const dayPass = { id: 3, name: "Day pass", kind: "day_pass" as const, price: "15.00", months: null, benefits: "", active: true, revision: 2 };
const offer = (plan: typeof monthly | typeof dayPass, amountCents: number, basis = "standard") => ({ ...plan, amountCents, basis, pricingRevision: 4 });

interface Data {
  enabled?: boolean;
  records?: unknown[];
  memberships?: unknown[];
  historyPasses?: unknown[];
  passes?: unknown[];
  offers?: unknown[];
  accessStatus?: string;
}
function mount(d: Data = {}, url = "/membership") {
  // The real hook keeps the same data object between renders; mirror that.
  const cache = new Map<string | null, unknown>();
  useApi.mockImplementation((path: string | null) => {
    if (cache.has(path)) return cache.get(path);
    const data =
      path === null ? null
      : path.startsWith("/me/billing/offers") ? (d.offers ?? [offer(monthly, 5000), offer(dayPass, 1500)])
      : path === "/me/billing/passes" ? (d.passes ?? [])
      : path === "/me/billing" ? { enabled: d.enabled ?? true, records: d.records ?? [] }
      : path === "/me/memberships" ? { memberships: d.memberships ?? [], passes: d.historyPasses ?? [], timeZone: "America/New_York", accessStatus: d.accessStatus ?? "active" }
      : path === "/plans" ? [monthly, dayPass]
      : { items: [], nextOffset: null };
    const result = { data, loading: false, refreshing: false, error: "", reload };
    cache.set(path, result);
    return result;
  });
  render(
    <MemoryRouter initialEntries={[url]}>
      <MembershipPage />
    </MemoryRouter>,
  );
}
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test("membership checkout needs consent in the confirm step and sends only the server quote", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: /Start membership/ }));
  const dialog = screen.getByRole("dialog", { name: "Start membership" });
  // FR-057: the consent itself states the 30-day notice and billing-date rule.
  expect(within(dialog).getByRole("checkbox").closest("label")!.textContent).toMatch(/first billing date that's at\s+least 30 days after I ask/);
  const pay = within(dialog).getByRole("button", { name: /Continue to payment/ }) as HTMLButtonElement;
  expect(pay.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  expect(pay.disabled).toBe(false);
  api.mockRejectedValue(new Error("Price changed; refresh first."));
  fireEvent.click(pay);
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Price changed");
  expect(api).toHaveBeenCalledWith("/me/billing/checkout", {
    method: "POST",
    body: { planId: 1, expectedRevision: 2, autoRenewConsent: true, pricingRevision: 4, amountCents: 5000 },
  });
});

test("without online billing, plans still show and point to the front desk", () => {
  mount({ enabled: false });
  expect(screen.getByText("$50.00")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Start membership/ })).toBeNull();
  expect(screen.getByText(/Ask at the front desk to sign up/)).toBeTruthy();
  expect(screen.queryByText(/test mode/)).toBeNull();
});

test("stopping auto-renew asks first, then cancels the member's own record", async () => {
  mount({
    memberships: [{ id: 9, planId: 1, effectiveStatus: "active", endsAt: "2030-02-01T00:00:00Z", plan: monthly }],
    records: [{ id: "billing-fixture", plan: monthly, status: "active", amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: "2030-02-01T00:00:00Z" }],
  });
  expect(screen.getByRole("heading", { name: /You're a member through/ })).toBeTruthy();
  expect(screen.getByText(/Next charge \$50\.00/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "You're on this plan" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  const dialog = screen.getByRole("dialog", { name: "Stop auto-renew?" });
  expect(api).not.toHaveBeenCalled();
  api.mockResolvedValue({ cancelled: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop auto-renew" }));
  await waitFor(() => expect(reload).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith("/me/billing/billing-fixture/cancel", { method: "POST", body: {} });
  expect((await screen.findByText(/Auto-renew stopped/)).getAttribute("role")).toBe("status");
});

test("day pass needs a date, shows the member's rate, and sends the quoted price", async () => {
  mount({ offers: [offer(monthly, 5000), offer(dayPass, 1000, "student")] });
  const buy = screen.getByRole("button", { name: "Choose a date" }) as HTMLButtonElement;
  expect(buy.disabled).toBe(true);
  expect(screen.getByText("Student rate")).toBeTruthy();
  const date = future(10);
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: date } });
  expect(screen.getByRole("button", { name: /Buy day pass · \$10\.00/ })).toBeTruthy();
  expect(screen.getByText(/Free cancellation through/)).toBeTruthy();
  api.mockRejectedValue(new Error("Refresh price"));
  fireEvent.click(screen.getByRole("button", { name: /Buy day pass/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("Refresh price");
  expect(api).toHaveBeenCalledWith("/me/billing/passes/checkout", {
    method: "POST",
    body: { planId: 3, expectedRevision: 2, pricingRevision: 4, amountCents: 1000, validDate: date },
  });
});

test("a free month says it doesn't renew and never opens card checkout", async () => {
  mount({ offers: [offer(monthly, 0, "school_partner"), offer(dayPass, 1500)] });
  fireEvent.click(screen.getByRole("button", { name: "Claim free month" }));
  const dialog = screen.getByRole("dialog", { name: "Claim free month" });
  expect(dialog.textContent).toContain("Doesn't renew");
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  api.mockResolvedValue({ issued: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "Claim free month" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/free-membership", { method: "POST", body: { planId: 1, expectedRevision: 2, pricingRevision: 4 } }));
});

test("upcoming passes show the cancel window and hide Cancel once it has passed", () => {
  mount({
    passes: [
      { id: "a", plan: dayPass, validDate: future(20), cancelBy: new Date(Date.now() + 17 * 86400000).toISOString(), status: "paid", refundStatus: null },
      { id: "b", plan: dayPass, validDate: future(1), cancelBy: new Date(Date.now() - 2 * 86400000).toISOString(), status: "paid", refundStatus: null },
    ],
  });
  const list = screen.getByRole("heading", { name: "Upcoming day passes" }).closest(".membership-passes") as HTMLElement;
  expect(list.textContent).toContain("Free cancellation through");
  expect(list.textContent).toContain("Too late to cancel for a refund");
  expect(within(list).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
});

test("returning from checkout waits for the payment, then confirms", () => {
  mount({ records: [{ id: "r", plan: monthly, status: "pending", amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: null }] }, "/membership?billing=returned");
  expect(screen.getByText("Confirming your payment…")).toBeTruthy();
  cleanup();
  mount({
    memberships: [{ id: 9, planId: 1, effectiveStatus: "active", endsAt: "2030-02-01T00:00:00Z", plan: monthly }],
    records: [{ id: "r", plan: monthly, status: "active", amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: "2030-02-01T00:00:00Z" }],
  }, "/membership?billing=returned");
  expect(screen.queryByText("Confirming your payment…")).toBeNull();
  expect(screen.getByText("Your current access and billing status are shown below.")).toBeTruthy();
});

test("a checkout return URL alone never claims a payment was received", () => {
  mount({}, "/membership?pass=returned");
  expect(screen.queryByText(/Payment received/)).toBeNull();
  expect(screen.getByText("Your current access and billing status are shown below.")).toBeTruthy();
});

test("cancelled checkout tells the member they weren't charged", () => {
  mount({}, "/membership?pass=cancelled");
  expect(screen.getByText("Checkout cancelled. You haven't been charged.")).toBeTruthy();
});

test("stored status values are shown in plain words", () => {
  expect(statusLabel("incomplete_expired")).toBe("Checkout expired");
  expect(statusLabel("expired")).toBe("Ended");
  expect(statusLabel("some_new_state")).toBe("Some new state");
});
