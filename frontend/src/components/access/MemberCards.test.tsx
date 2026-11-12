// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemberCards } from "./MemberCards";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api }));
import { ApiError } from "../../lib/api";

const card = {
  id: 5, label: "Blue fob", last4: "1A2B", active: true, revision: 3,
  assignedAt: "2026-10-01T12:00:00Z", assignedBy: "Sam Staff", lastUsedAt: null, lastReader: null,
};
let change: () => Promise<unknown>;
beforeEach(() => {
  change = () => Promise.resolve({});
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/admin/access/cards?userId=14") return Promise.resolve([card]);
    if (path === "/admin/access/readers") return Promise.reject(new ApiError(503, "unavailable", "Readers unavailable"));
    if (options?.method === "POST" && path === "/admin/access/cards/5/revoke") return change();
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const openRevoke = async (onChanged = vi.fn()) => {
  render(<MemberCards userId={14} memberName="Casey Demo" onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Blue fob" }));
  const dialog = screen.getByRole("dialog", { name: "Revoke Blue fob?" });
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Lost card" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm revocation" }));
  return dialog;
};
const cardReads = () => api.mock.calls.filter(([path]) => path === "/admin/access/cards?userId=14").length;

test("a failed revoke keeps the dialog open with the error and the reason, and can be retried", async () => {
  change = () => Promise.reject(new ApiError(500, "server_error", "Card service failed"));
  const onChanged = vi.fn();
  const dialog = await openRevoke(onChanged);
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Card service failed");
  expect(screen.getByRole("dialog", { name: "Revoke Blue fob?" })).toBe(dialog);
  expect((within(dialog).getByLabelText("Reason") as HTMLInputElement).value).toBe("Lost card");
  expect(onChanged).not.toHaveBeenCalled();
  await waitFor(() => expect(cardReads()).toBe(2));
  // Not a conflict, so trying again is allowed and a success closes the dialog.
  change = () => Promise.resolve({});
  const confirm = within(dialog).getByRole("button", { name: "Confirm revocation" }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revoke Blue fob?" })).toBeNull());
  expect(screen.getByRole("status").textContent).toContain("Blue fob revoked for Casey Demo.");
  expect(onChanged).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(cardReads()).toBe(3));
  expect(api).toHaveBeenCalledWith("/admin/access/cards/5/revoke", { method: "POST", body: { expectedRevision: 3, reason: "Lost card" } });
});

test("a revoke that lost a race says the card changed, loads the latest and stops offering the old revision", async () => {
  change = () => Promise.reject(new ApiError(409, "revision_conflict", "Revision conflict"));
  const dialog = await openRevoke();
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "This card changed since you opened it. The latest is loaded; close this and check the card before trying again.",
  );
  expect((within(dialog).getByRole("button", { name: "Confirm revocation" }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(cardReads()).toBe(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Revoke Blue fob?" })).toBeNull();
  // Reopening starts clean.
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Blue fob" }));
  const again = screen.getByRole("dialog", { name: "Revoke Blue fob?" });
  expect(within(again).queryByRole("alert")).toBeNull();
  expect((within(again).getByRole("button", { name: "Confirm revocation" }) as HTMLButtonElement).disabled).toBe(false);
});
