// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MembershipPage } from "./MembershipPage";

const { api, reload, useApi } = vi.hoisted(() => ({ api: vi.fn(), reload: vi.fn(), useApi: vi.fn() }));
vi.mock("../lib/api", () => ({ api, errorMessage: (e: Error) => e.message }));
vi.mock("../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const dayPass = { id: 3, name: "Day pass", kind: "day_pass" as const, price: "15.00", months: null, benefits: "", active: true, revision: 2 };
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function mount(pass: Record<string, unknown>) {
  const cache = new Map<string | null, unknown>();
  useApi.mockImplementation((path: string | null) => {
    if (cache.has(path)) return cache.get(path);
    const data =
      path === null ? null
      : path.startsWith("/me/billing/offers") ? []
      : path === "/me/waivers?scope=facility" ? [{ id: 1, name: "Terms of Service", signed: true, scope: "facility" }]
      : path === "/me/billing/passes" ? [pass]
      : path === "/me/billing" ? { enabled: true, records: [] }
      : path === "/me/memberships" ? { memberships: [], passes: [], timeZone: "America/New_York", accessStatus: "active" }
      : path === "/plans" ? [dayPass]
      : { items: [], nextOffset: null };
    const result = { data, loading: false, refreshing: false, error: "", reload };
    cache.set(path, result);
    return result;
  });
  render(
    <MemoryRouter>
      <MembershipPage />
    </MemoryRouter>,
  );
}

const upcoming = { id: "pass-1", plan: dayPass, validDate: future(20), cancelBy: new Date(Date.now() + 17 * 86400000).toISOString(), status: "paid", refundStatus: null };

/** Cancels the upcoming card day pass through the confirm dialog and returns the page message. */
async function cancelWith(response: Record<string, unknown>) {
  mount(upcoming);
  api.mockResolvedValue(response);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel day pass?" })).getByRole("button", { name: "Cancel day pass" }));
  const message = await screen.findByText((_, el) => !!el && /membership-message|form-error/.test(el.className) && el.tagName === "P");
  expect(api).toHaveBeenCalledWith("/me/billing/passes/pass-1/cancel", { method: "POST", body: {} });
  return message;
}

test("a succeeded refund reports the pass cancelled", async () => {
  const message = await cancelWith({ cancelled: true, refundStatus: "succeeded" });
  expect(message.textContent).toBe("Day pass cancelled.");
  expect(message.getAttribute("role")).toBe("status");
});

test("a free or already-closed pass reports the pass cancelled", async () => {
  const message = await cancelWith({ cancelled: true });
  expect(message.textContent).toBe("Day pass cancelled.");
  expect(message.getAttribute("role")).toBe("status");
});

test("a desk-paid pass still asks the member to see staff for the refund", async () => {
  const message = await cancelWith({ cancelled: true, manualRefundRequired: true });
  expect(message.textContent).toBe("Day pass cancelled. Ask staff at the front desk for your refund.");
});

test.each(["pending", "requires_action"])("a %s refund does not claim the pass is cancelled yet", async (refundStatus) => {
  const message = await cancelWith({ cancelled: false, refundStatus });
  expect(message.textContent).toBe("Your day pass cancellation is waiting on the refund. We'll email you when it's done.");
  expect(message.textContent).not.toMatch(/Day pass cancelled/);
  expect(message.getAttribute("role")).toBe("status");
});

test.each(["failed", "canceled"])("a %s refund is an error and says the pass is still active", async (refundStatus) => {
  const message = await cancelWith({ cancelled: false, refundStatus });
  expect(message.textContent).toBe("We couldn't refund this day pass, so it is still active. Please ask staff at the front desk.");
  expect(message.getAttribute("role")).toBe("alert");
  expect(message.className).toBe("form-error");
});

test("an unknown outcome neither claims cancellation nor failure", async () => {
  const message = await cancelWith({ cancelled: false, refundStatus: null });
  expect(message.textContent).toMatch(/couldn't confirm your day pass cancellation/);
  expect(message.textContent).toMatch(/Refresh/);
  expect(message.getAttribute("role")).toBe("status");
});

test("a failed cancel request still shows the server error", async () => {
  mount(upcoming);
  api.mockRejectedValue(new Error("Day passes require at least 3 days cancellation notice."));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel day pass?" })).getByRole("button", { name: "Cancel day pass" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Day passes require at least 3 days cancellation notice.");
});

/** A card payment refunded because no pass could be issued (its date had ended), whose refund failed. */
const unissued = { id: "pass-2", plan: dayPass, validDate: future(-2), cancelBy: new Date(Date.now() - 5 * 86400000).toISOString(), status: "paid", refundStatus: "failed" };

/** Retries that refund and returns the page message. */
async function retryWith(response: Record<string, unknown>) {
  mount(unissued);
  api.mockResolvedValue(response);
  // Its date has passed, but the failed refund still offers a retry.
  fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
  const message = await screen.findByText((_, el) => !!el && /membership-message|form-error/.test(el.className) && el.tagName === "P");
  expect(api).toHaveBeenCalledWith("/me/billing/passes/pass-2/cancel", { method: "POST", body: {} });
  return message;
}

test("a failed retry for a payment that never became a pass doesn't call a pass active", async () => {
  const message = await retryWith({ cancelled: false, refundStatus: "failed", passIssued: false });
  expect(message.textContent).toBe("We couldn't refund this payment. No day pass was issued for it. Please ask staff at the front desk.");
  expect(message.getAttribute("role")).toBe("alert");
});

test("a successful retry for a payment that never became a pass reports the refund, not a cancellation", async () => {
  const message = await retryWith({ cancelled: true, refundStatus: "succeeded", passIssued: false });
  expect(message.textContent).toBe("Your payment was refunded. No day pass was issued for it.");
  expect(message.getAttribute("role")).toBe("status");
});

test("a pending retry for a payment that never became a pass says the refund is coming", async () => {
  const message = await retryWith({ cancelled: false, refundStatus: "pending", passIssued: false });
  expect(message.textContent).toMatch(/refund is on its way\. No day pass was issued/);
  expect(message.textContent).not.toMatch(/cancel/i);
});

test("a past pass whose refund didn't fail is no longer listed", () => {
  mount({ ...unissued, refundStatus: null });
  expect(screen.queryByRole("heading", { name: "Upcoming day passes" })).toBeNull();
});
