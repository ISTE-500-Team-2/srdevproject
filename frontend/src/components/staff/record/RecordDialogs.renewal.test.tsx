// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordDialogHost } from "./RecordDialogs";
import { RecordMembership } from "./RecordMembership";
import type { Entitlement, Person } from "../../../lib/staffContracts";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../lib/api", async (original) => ({ ...(await original<typeof import("../../../lib/api")>()), api }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const now = Date.now();
const membership = (over: Partial<Entitlement> = {}): Entitlement => ({
  id: 21, userId: 3, planId: 1, status: "active", effectiveStatus: "active", revision: 2, reason: "",
  startsAt: new Date(now - 10 * 86400000).toISOString(), endsAt: new Date(now + 20 * 86400000).toISOString(),
  plan: { name: "Monthly", price: "50.00" }, cardBilled: true, autoRenews: true, renewalEndsAt: null, ...over,
});
const person = { id: 3, firstName: "Ada", status: "active", revision: 1 } as Person;
const plan = (item: Entitlement, open = vi.fn()) =>
  render(<RecordMembership person={person} memberships={[item]} passes={[]} canManage allEarlier={false} showAllEarlier={vi.fn()} open={open} />);

test("staff can stop a card membership's auto-renew for a member who can't sign in", () => {
  const open = vi.fn();
  const item = membership();
  plan(item, open);
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  expect(open).toHaveBeenCalledWith({ kind: "stopRenewal", item });
});

test("there is nothing to stop for a desk-paid membership or one already stopped, which shows its last day", () => {
  plan(membership({ cardBilled: false, autoRenews: false }));
  expect(screen.queryByRole("button", { name: "Stop auto-renew" })).toBeNull();
  cleanup();
  plan(membership({ autoRenews: false, renewalEndsAt: "2026-12-15T17:00:00Z" }));
  expect(screen.queryByRole("button", { name: "Stop auto-renew" })).toBeNull();
  expect(screen.getByText(/Auto-renew is off\. Card billing ends/)).toBeTruthy();
});

test("stopping auto-renew asks for a reason and calls the staff route for that membership", async () => {
  api.mockResolvedValue({ stopped: true });
  const onDone = vi.fn();
  render(
    <RecordDialogHost
      dialog={{ kind: "stopRenewal", item: membership() }}
      person={person}
      plans={[]}
      timeZone="America/New_York"
      supervision={null}
      onClose={vi.fn()}
      onDone={onDone}
      onPerson={vi.fn()}
      onConflict={vi.fn()}
    />,
  );
  expect(screen.getByText(/at least 30 days from today/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Access suspended; member asked by phone" } });
  fireEvent.click(screen.getByRole("button", { name: "Stop auto-renew" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledWith("/admin/users/3/memberships/21/stop-renewal", {
    method: "POST",
    body: { reason: "Access suspended; member asked by phone" },
  });
  expect(onDone.mock.calls[0][0]).toBe("Ada’s auto-renew is off. Ada gets an email with the last day.");
});
