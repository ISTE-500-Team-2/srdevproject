// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MembershipPage } from "./MembershipPage";
import { shortDate, statusLabel, zonedDay } from "../lib/display";
import { addCalendarDays } from "../lib/calendarDate";

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
  passesError?: string;
  offers?: unknown[];
  /** Quotes for specific visit dates, when they differ from `offers`. */
  offersByDate?: Record<string, unknown[]>;
  accessStatus?: string;
  policies?: { id: number; name: string; signed: boolean; scope: 'facility' | 'equipment' }[];
  policyError?: string;
}
function mount(d: Data = {}, url = "/membership") {
  // The real hook keeps the same data object between renders; mirror that.
  const cache = new Map<string | null, unknown>();
  useApi.mockImplementation((path: string | null) => {
    if (cache.has(path)) return cache.get(path);
    const data =
      path === null ? null
      : path.startsWith("/me/billing/offers")
        ? (d.offersByDate?.[new URLSearchParams(path.split("?")[1]).get("date") ?? ""] ?? d.offers ?? [offer(monthly, 5000), offer(dayPass, 1500)])
      : path === '/me/waivers?scope=facility' ? (d.policies ?? [{ id: 1, name: 'Terms of Service', signed: true, scope: 'facility' }])
      : path === "/me/billing/passes" ? (d.passesError ? null : d.passes ?? [])
      : path === "/me/billing" ? { enabled: d.enabled ?? true, records: d.records ?? [] }
      : path === "/me/memberships" ? { memberships: d.memberships ?? [], passes: d.historyPasses ?? [], timeZone: "America/New_York", accessStatus: d.accessStatus ?? "active" }
      : path === "/plans" ? [monthly, dayPass]
      : { items: [], nextOffset: null };
    const error = path === '/me/waivers?scope=facility' ? d.policyError ?? '' : path === "/me/billing/passes" ? d.passesError ?? '' : '';
    const result = { data, loading: false, refreshing: false, error, reload };
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
  expect(screen.queryByLabelText("Visit date")).toBeNull();
  expect(screen.getByText("Buy a day pass at the front desk.")).toBeTruthy();
  expect(screen.getByText("Sign up or buy a pass at the front desk.")).toBeTruthy();
  expect(screen.queryByText(/test mode/)).toBeNull();
});

test("without online billing, approved free access is still claimed here", async () => {
  mount({ enabled: false, offers: [offer(monthly, 0, "school_partner"), offer(dayPass, 0, "school_partner")] });
  expect(screen.getByText(/^Claim your approved free access here\. Paid plans and passes are sold at the front desk\.$/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Claim free month" }));
  const dialog = screen.getByRole("dialog", { name: "Claim free month" });
  api.mockResolvedValue({ issued: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "Claim free month" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/free-membership", { method: "POST", body: { planId: 1, expectedRevision: 2, pricingRevision: 4 } }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const date = future(10);
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: date } });
  fireEvent.click(screen.getByRole("button", { name: "Claim free day pass" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/passes/checkout", {
    method: "POST",
    body: { planId: 3, expectedRevision: 2, pricingRevision: 4, amountCents: 0, validDate: date },
  }));
});

test("without online billing, free access ending within the month still claims passes for the dates it covers", async () => {
  const today = zonedDay("America/New_York");
  const covered = addCalendarDays(today, 7);
  const free = [offer(monthly, 5000), offer(dayPass, 0, "school_partner")];
  // Partner access ends in two weeks: a month ahead is paid, but today and next week are free.
  mount({ enabled: false, offers: [offer(monthly, 5000), offer(dayPass, 1500)], offersByDate: { [today]: free, [covered]: free } });
  expect(useApi).toHaveBeenCalledWith(`/me/billing/offers?date=${today}`, expect.anything());
  expect(screen.getByText(/^Claim your approved free access here/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: addCalendarDays(today, 40) } });
  expect(screen.queryByRole("button", { name: /^(Buy|Claim free) day pass/ })).toBeNull();
  expect(screen.getByText("Buy a day pass for this date at the front desk.")).toBeTruthy();
  // The picker stays, so the member can go back to a date their free access covers.
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: covered } });
  api.mockResolvedValue({ issued: true });
  fireEvent.click(screen.getByRole("button", { name: "Claim free day pass" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/passes/checkout", {
    method: "POST",
    body: { planId: 3, expectedRevision: 2, pricingRevision: 4, amountCents: 0, validDate: covered },
  }));
});

test.each([true, false])("a member whose access is on hold isn't quoted and is sent to the front desk (card payments: %s)", enabled => {
  mount({ enabled, accessStatus: "suspended", offers: [offer(monthly, 0, "school_partner"), offer(dayPass, 0, "school_partner")] });
  expect(useApi).not.toHaveBeenCalledWith(expect.stringMatching(/^\/me\/billing\/offers/), expect.anything());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /Start membership|Claim free/ })).toBeNull();
  expect(screen.queryByLabelText("Visit date")).toBeNull();
  expect(screen.getByText(/Ask at the front desk to sign up/)).toBeTruthy();
  expect(screen.getByText("Buy a day pass at the front desk.")).toBeTruthy();
  expect(screen.getByText("Sign up or buy a pass at the front desk.")).toBeTruthy();
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

test('unsigned facility policies block day-pass purchases and link to the agreements', () => {
  mount({ policies: [{ id: 1, name: 'Terms of Service', signed: false, scope: 'facility' }] });
  fireEvent.change(screen.getByLabelText('Visit date'), { target: { value: future(10) } });
  expect((screen.getByRole('button', { name: /Buy day pass/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('link', { name: /review and sign the required facility policies/ }).getAttribute('href')).toBe('/certifications');
  expect(screen.getByText(/Before buying a day pass/).textContent).toContain('Terms of Service');
  expect(api).not.toHaveBeenCalled();
});

test.each([[], undefined])('missing or unavailable facility policies cannot enable checkout (%s)', policies => {
  mount({ policies, policyError: policies === undefined ? 'Policy service unavailable' : '' });
  fireEvent.change(screen.getByLabelText('Visit date'), { target: { value: future(10) } });
  expect((screen.getByRole('button', { name: /Buy day pass/ }) as HTMLButtonElement).disabled).toBe(true);
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

test("a day-pass return does not wait on an earlier, abandoned membership checkout", () => {
  mount({
    records: [{ id: "r", plan: monthly, status: "pending", amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: null }],
    passes: [{ id: "p", plan: dayPass, validDate: future(10), cancelBy: new Date(Date.now() + 7 * 86400000).toISOString(), status: "paid", refundStatus: null }],
  }, "/membership?pass=returned");
  expect(screen.queryByText("Confirming your payment…")).toBeNull();
  expect(screen.getByText("Your current access and billing status are shown below.")).toBeTruthy();
  cleanup();
  // A pass that is still being paid for is what a pass return waits on.
  mount({ passes: [{ id: "p", plan: dayPass, validDate: future(10), cancelBy: new Date(Date.now() + 7 * 86400000).toISOString(), status: "pending", refundStatus: null }] }, "/membership?pass=returned");
  expect(screen.getByText("Confirming your payment…")).toBeTruthy();
});

test("a pass return waits only on the checkout it came back from", () => {
  const pass = (id: string, status: string, days: number) => ({ id, plan: dayPass, validDate: future(days), cancelBy: new Date(Date.now() + (days - 3) * 86400000).toISOString(), status, refundStatus: null, amountCents: 1500 });
  // An abandoned checkout for another date stays pending until the provider expires it.
  mount({ passes: [pass("old", "pending", 5), pass("new", "paid", 6)] }, "/membership?pass=returned&checkout=new");
  expect(screen.queryByText("Confirming your payment…")).toBeNull();
  expect(screen.getByText("Your current access and billing status are shown below.")).toBeTruthy();
  cleanup();
  mount({ passes: [pass("old", "pending", 5), pass("new", "pending", 6)] }, "/membership?pass=returned&checkout=new");
  expect(screen.getByText("Confirming your payment…")).toBeTruthy();
  cleanup();
  // Older return links name no checkout; a pending pass for a past date is not this one.
  mount({ passes: [pass("old", "pending", -3), pass("new", "paid", 6)] }, "/membership?pass=returned");
  expect(screen.queryByText("Confirming your payment…")).toBeNull();
});

test("the confirming banner ends after a minute even if a status list keeps failing", () => {
  vi.useFakeTimers();
  try {
    mount({ passesError: "Server unavailable" }, "/membership?pass=returned");
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText("Confirming your payment…")).toBeNull();
    expect(screen.getByText("We couldn't check your payment status. Refresh this page in a moment.")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("a payment that is still pending after a minute says it is still processing", () => {
  vi.useFakeTimers();
  try {
    mount({ records: [{ id: "r", plan: monthly, status: "pending", amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: null }] }, "/membership?billing=returned");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText("Confirming your payment…")).toBeNull();
    expect(screen.getByText("Your payment is still processing. This page will update when it clears.")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

const lapsed = [{ id: 9, planId: 1, effectiveStatus: "expired", endsAt: "2020-02-01T00:00:00Z", plan: monthly }];
const billingRecord = (status: string, extra: object = {}) => ({ id: "b", plan: monthly, status, amountCents: 5000, cancelAtPeriodEnd: false, currentPeriodEnd: "2030-02-01T00:00:00Z", ...extra });

test.each(["past_due", "unpaid", "paused"])("a %s renewal asks the member to update their card instead of waiting", (status) => {
  mount({ memberships: lapsed, records: [billingRecord(status)] });
  expect(screen.getByRole("heading", { name: "Your last payment didn't go through" })).toBeTruthy();
  expect(screen.getByText("Payment failed")).toBeTruthy();
  expect(screen.queryByText(/being set up|waiting for your payment/)).toBeNull();
  expect(screen.queryByText(/Next charge/)).toBeNull();
  expect(screen.getByText(/a month · payment failed/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage payment method" }).className).toContain("button--primary");
});

test("a first payment that never cleared asks for a card to start the membership, not keep it", () => {
  mount({ records: [billingRecord("incomplete")] });
  expect(screen.getByRole("heading", { name: "Your first payment hasn't gone through" })).toBeTruthy();
  expect(screen.getByText("Update your payment method to start your membership.")).toBeTruthy();
  // Same words as the billing history uses for this status.
  expect(screen.getByText(statusLabel("incomplete"), { selector: ".membership-status .plan-pill" })).toBeTruthy();
  expect(screen.getByText(/a month · first payment not finished/)).toBeTruthy();
  expect(screen.queryByText(/Next charge|payment failed|didn't go through/)).toBeNull();
});

test("stopping auto-renew after a failed payment doesn't promise access the member no longer has", () => {
  mount({ memberships: lapsed, records: [billingRecord("past_due")] });
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  const dialog = screen.getByRole("dialog", { name: "Stop auto-renew?" });
  expect(dialog.textContent).not.toMatch(/keep studio access/);
  expect(dialog.textContent).toContain("you won't have studio access unless you update your payment method");
});

test("an unconfirmed stop request after a failed payment still says what Try again retries", () => {
  mount({ memberships: lapsed, records: [billingRecord("past_due", { cancellationEffectiveAt: "2030-03-01T00:00:00Z" })] });
  expect(screen.getByText(/a month · payment failed/)).toBeTruthy();
  expect(screen.getByText(/You asked to stop auto-renew from .* We're confirming this with the payment provider\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a pass staff put on hold has no Cancel button, and a revoked one is no longer listed", () => {
  const pass = (id: string, status: string, days: number) => ({ id, plan: dayPass, validDate: future(days), cancelBy: new Date(Date.now() + (days - 3) * 86400000).toISOString(), status, refundStatus: null, amountCents: 1500 });
  mount({ passes: [pass("held", "suspended", 10), pass("gone", "revoked", 12)] });
  const list = screen.getByRole("heading", { name: "Upcoming day passes" }).closest(".membership-passes") as HTMLElement;
  expect(list.textContent).toContain("1 booked");
  expect(list.textContent).toContain("On hold. Please contact staff about this pass.");
  expect(list.textContent).not.toContain(shortDate(future(12)));
  expect(within(list).queryByRole("button")).toBeNull();
});

test("a member whose only access is a future day pass is told when it is", () => {
  const scheduled = (id: number, days: number) => ({ id, userId: 1, planId: 3, status: "active", effectiveStatus: "scheduled", revision: 1, reason: "", validDate: future(days), plan: { name: "Day pass" } });
  mount({ historyPasses: [scheduled(2, 20), scheduled(1, 10)] });
  expect(screen.getByRole("heading", { name: `Your next day pass is ${shortDate(future(10))}` })).toBeTruthy();
  expect(screen.queryByText("You don't have a membership or pass yet")).toBeNull();
});

test("cancelling a free day pass doesn't promise a card refund", () => {
  const pass = (amountCents: number) => ({ id: "p", plan: dayPass, validDate: future(20), cancelBy: new Date(Date.now() + 17 * 86400000).toISOString(), status: "paid", refundStatus: null, amountCents });
  mount({ passes: [pass(0)] });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel day pass?" });
  expect(dialog.textContent).toContain("This pass was free, so there's nothing to refund.");
  expect(dialog.textContent).not.toMatch(/refund the full amount/);
  cleanup();
  mount({ passes: [pass(1500)] });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("dialog", { name: "Cancel day pass?" }).textContent).toContain("We'll refund the full amount to your card.");
});

test("a day pass for a visit under 3 days away says it can't be cancelled for a refund", () => {
  const today = zonedDay("America/New_York");
  mount();
  // Four days ahead is the last date that still allows free cancellation today.
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: addCalendarDays(today, 4) } });
  expect(screen.getByText(`Free cancellation through ${shortDate(today)}`)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Visit date"), { target: { value: addCalendarDays(today, 2) } });
  expect(screen.queryByText(/Free cancellation through/)).toBeNull();
  expect(screen.getByText(/Can't be cancelled for a refund: day passes need 3 days' notice/)).toBeTruthy();
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

const deskMembership = (extra: object = {}) => ({ id: 9, userId: 1, planId: 1, status: "active", effectiveStatus: "active", revision: 1, reason: "", cardBilled: false, startsAt: future(-5), endsAt: future(90), plan: { name: "Monthly" }, ...extra });

test("FR-057: a desk-issued membership can be cancelled with its 30 days of notice explained", async () => {
  mount({ memberships: [deskMembership()] });
  api.mockResolvedValue({ cancelled: true });
  fireEvent.click(screen.getByRole("button", { name: "Cancel membership" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel membership?" });
  expect(dialog.textContent).toMatch(/30 days/);
  expect(dialog.textContent).toMatch(/won't renew/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel membership" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/memberships/9/cancel", { method: "POST", body: {} }));
  expect(await screen.findByText(/Membership cancelled/)).toBeTruthy();
});

test("FR-057: a cancelled desk membership shows its last day instead of the button", () => {
  mount({ memberships: [deskMembership({ cancellationRequestedAt: future(-1) })] });
  expect(screen.queryByRole("button", { name: "Cancel membership" })).toBeNull();
  expect(screen.getByText(/You cancelled this membership/)).toBeTruthy();
});

test("FR-057: card memberships keep using Stop auto-renew, even after billing closes", () => {
  mount({ memberships: [deskMembership({ cardBilled: true })] });
  expect(screen.queryByRole("button", { name: "Cancel membership" })).toBeNull();
});

test("FR-057: a scheduled desk membership can be cancelled outright before it starts", async () => {
  mount({ memberships: [deskMembership({ effectiveStatus: "scheduled", startsAt: future(10), endsAt: future(40) })] });
  api.mockResolvedValue({ cancelled: true, endsAt: null });
  expect(screen.queryByRole("button", { name: "Cancel membership" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel upcoming membership" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel upcoming membership?" });
  expect(dialog.textContent).toMatch(/cancelled now, so it won't start/);
  expect(dialog.textContent).not.toMatch(/30 days/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel membership" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/me/billing/memberships/9/cancel", { method: "POST", body: {} }));
  expect(await screen.findByText("Upcoming membership cancelled. It won't start.")).toBeTruthy();
});

test("FR-057: a suspended desk membership can be cancelled with notice and says it stays on hold", async () => {
  mount({ memberships: [deskMembership({ status: "suspended", effectiveStatus: "suspended" })] });
  expect(screen.getByText("Monthly is on hold.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel membership" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel membership?" });
  expect(dialog.textContent).toMatch(/30 days/);
  expect(dialog.textContent).toMatch(/stays on hold until then/);
  expect(dialog.textContent).not.toMatch(/keep studio access/);
});

test("FR-057: ended, revoked, cancelled and card memberships offer no cancel button", () => {
  mount({ memberships: [
    deskMembership({ id: 1, status: "suspended", effectiveStatus: "suspended", startsAt: future(-60), endsAt: future(-30) }),
    deskMembership({ id: 2, status: "revoked", effectiveStatus: "revoked" }),
    deskMembership({ id: 3, status: "cancelled", effectiveStatus: "cancelled", startsAt: future(5), endsAt: future(35) }),
    deskMembership({ id: 4, effectiveStatus: "scheduled", startsAt: future(100), endsAt: future(130), cardBilled: true }),
  ] });
  expect(screen.queryByRole("button", { name: /^Cancel (upcoming )?membership$/ })).toBeNull();
});

test("FR-057: a pending checkout does not hide cancelling the current desk membership", () => {
  mount({ memberships: [deskMembership()], records: [{ id: "b1", status: "pending", amountCents: 5000, plan: { name: "Monthly" }, planSnapshot: { name: "Monthly" } }] });
  expect(screen.getByRole("button", { name: "Cancel checkout" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel membership" })).toBeTruthy();
});
