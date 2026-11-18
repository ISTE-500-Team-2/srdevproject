// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { History } from "./History";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  useApi.mockReset();
});

test("another page of payments keeps this one on screen, out of reach, and the pressed button keeps focus", () => {
  const payments = {
    items: [{ id: 9, userId: 1, memberName: "", membershipId: 1, dayPassId: null, amount: "45.00", status: "paid", method: "card", reference: "", revision: 1, recordedAt: "2026-11-01T15:00:00Z", updatedAt: "2026-11-01T15:00:00Z", planName: "Monthly" }],
    nextOffset: 10,
  };
  let stale = false;
  useApi.mockImplementation(() => ({ data: payments, loading: false, refreshing: stale, stale, error: "", reload: vi.fn() }));
  render(<History memberships={[]} passes={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /History/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Payments" }));
  expect(useApi.mock.calls.find(([path]) => path?.startsWith("/me/payments"))?.[1]).toMatchObject({ retainOnChange: true });
  const next = screen.getByRole("button", { name: "Next" });
  next.focus();
  stale = true;
  fireEvent.click(next);
  expect(useApi.mock.lastCall?.[0]).toBe("/me/payments?offset=10");
  const results = document.querySelector(".kept-results")!;
  expect(results.hasAttribute("inert")).toBe(true);
  expect(results.contains(next)).toBe(false);
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
});

test("payments staff recorded at the desk say so; online card payments don't", () => {
  const payment = (id: number, method: string, planName: string) => ({ id, userId: 1, memberName: "", membershipId: 1, dayPassId: null, amount: "45.00", status: "paid", method, reference: "", revision: 1, recordedAt: "2026-11-01T15:00:00Z", updatedAt: "2026-11-01T15:00:00Z", planName });
  const items = [payment(1, "cash", "Cash plan"), payment(2, "external_card", "Desk card plan"), payment(3, "bank_transfer", "Transfer plan"), payment(4, "other", "Other plan"), payment(5, "card", "Online plan")];
  useApi.mockImplementation(() => ({ data: { items, nextOffset: null }, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() }));
  render(<History memberships={[]} passes={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /History/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Payments" }));
  const cell = (plan: string) => screen.getByText(plan, { exact: false }).closest("td")!.textContent;
  for (const plan of ["Cash plan", "Desk card plan", "Transfer plan", "Other plan"]) expect(cell(plan)).toContain("Paid at front desk");
  expect(cell("Online plan")).not.toContain("Paid at front desk");
});

test("the history tabs name their panel and move with the arrow keys", () => {
  useApi.mockImplementation(() => ({ data: { items: [], nextOffset: null }, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() }));
  render(<History memberships={[]} passes={[]} />);
  const toggle = screen.getByRole("button", { name: /History/ });
  // Collapsed, the toggle doesn't point at a body that isn't there.
  expect(toggle.hasAttribute("aria-controls")).toBe(false);
  fireEvent.click(toggle);
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();

  const records = screen.getByRole("tab", { name: "Memberships & passes" });
  const payments = screen.getByRole("tab", { name: "Payments" });
  expect(screen.getByRole("tabpanel", { name: "Memberships & passes" }).id).toBe(records.getAttribute("aria-controls"));
  expect([records.tabIndex, payments.tabIndex]).toEqual([0, -1]);

  records.focus();
  fireEvent.keyDown(records, { key: "ArrowRight" });
  expect(document.activeElement).toBe(payments);
  expect(payments.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Payments" })).toBeTruthy();
  expect([records.tabIndex, payments.tabIndex]).toEqual([-1, 0]);
  // The arrows wrap around, and Home goes to the first tab.
  fireEvent.keyDown(payments, { key: "ArrowRight" });
  expect(document.activeElement).toBe(records);
  fireEvent.keyDown(records, { key: "End" });
  expect(document.activeElement).toBe(payments);
  fireEvent.keyDown(payments, { key: "Home" });
  expect(document.activeElement).toBe(records);
  expect(screen.getByRole("tabpanel", { name: "Memberships & passes" })).toBeTruthy();
});
