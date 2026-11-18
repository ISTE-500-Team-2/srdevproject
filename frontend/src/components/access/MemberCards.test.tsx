// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemberCards } from "./MemberCards";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api }));
import { ApiError } from "../../lib/api";
import type { CardScan, NfcCard, ReaderSetup } from "../../lib/nfc";

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
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

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

const readers = {
  configured: true,
  timeZone: "America/New_York",
  readers: [{
    id: "front", name: "Front door", kind: "building", resourceId: 1, resourceName: "Main building",
    enabled: true, online: true, revision: 1, lastSeenAt: "2026-10-01T12:00:00Z",
  }],
} satisfies ReaderSetup;
let reads: Promise<unknown>[] = [];
/** Lets every list read so far land and render. */
const settle = () => act(async () => { await Promise.all(reads); });
/** A reader that answers scans: the enrollment poll returns `scan()` and card saves go to `save`. */
function scanServer(list: NfcCard[], scan: () => Partial<CardScan>, save: (body: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({})) {
  reads = [];
  const read = (value: unknown) => { const result = Promise.resolve(value); reads.push(result); return result; };
  api.mockImplementation((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === "/admin/access/cards?userId=14") return read(list.map((c) => ({ ...c })));
    if (path === "/admin/access/readers") return read(readers);
    if (options?.method === "POST" && path === "/admin/access/enrollments")
      return Promise.resolve({ id: "scan-1", readerId: "front", userId: 14, purpose: "assign", status: "waiting", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    if (path === "/admin/access/enrollments/scan-1")
      return Promise.resolve({ id: "scan-1", readerId: "front", userId: 14, purpose: "assign", expiresAt: new Date(Date.now() + 120_000).toISOString(), ...scan() });
    if (options?.method === "POST" && path.endsWith("/cancel")) return Promise.resolve({});
    if (options?.method === "POST" && path === "/admin/access/cards") return save(options.body!);
    if (options?.method === "POST" && path === "/admin/access/cards/5/revoke") return change();
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
}
const cancels = () => api.mock.calls.filter(([path]) => String(path).endsWith("/cancel")).length;
const typeAssignment = () => {
  fireEvent.change(screen.getByLabelText("Card label"), { target: { value: "Spare fob" } });
  fireEvent.change(screen.getByLabelText("Assignment reason"), { target: { value: "Verified ID" } });
};
const assignButton = (name = "Assign card") => screen.getByRole("button", { name }) as HTMLButtonElement;

test("refreshing the cards keeps a scan in progress and what staff typed", async () => {
  scanServer([card], () => ({ status: "waiting" }));
  render(<MemberCards userId={14} memberName="Casey Demo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Start card scan" }));
  await screen.findByText("Tap one NFC card at Front door for Casey Demo.");
  // The label and reason can be filled in while waiting; saving waits for the tap.
  typeAssignment();
  expect(assignButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cards" }));
  await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/admin/access/readers")).toHaveLength(2));
  await waitFor(() => expect(cardReads()).toBe(2));
  await settle();
  expect(screen.getByText("Tap one NFC card at Front door for Casey Demo.")).toBeTruthy();
  expect((screen.getByLabelText("Card label") as HTMLInputElement).value).toBe("Spare fob");
  expect(cancels()).toBe(0);
});

test("a late tap keeps the typed label and reason, and they survive the scan expiring and a new scan", async () => {
  // Fake time drives the 1 s enrollment poll and the expiry tick, so this never waits on the clock.
  vi.useFakeTimers();
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  let scan: () => Partial<CardScan> = () => ({ status: "waiting" });
  scanServer([], () => scan());
  render(<MemberCards userId={14} memberName="Casey Demo" />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  await advance(0);
  expect(screen.getByText("Tap one NFC card at Front door for Casey Demo.")).toBeTruthy();
  typeAssignment();
  // Tapped with little time left in the window.
  scan = () => ({ status: "captured", last4: "7788", assignments: [], expiresAt: new Date(Date.now() + 1200).toISOString() });
  await advance(1000);
  expect(screen.getByText("Card captured · ending 7788")).toBeTruthy();
  expect(assignButton().disabled).toBe(false);
  expect((screen.getByLabelText("Card label") as HTMLInputElement).value).toBe("Spare fob");
  await advance(1500);
  expect(screen.getByText("This scan expired. Start a new scan.")).toBeTruthy();
  expect(assignButton().disabled).toBe(true);
  expect((screen.getByLabelText("Assignment reason") as HTMLInputElement).value).toBe("Verified ID");
  scan = () => ({ status: "waiting" });
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  await advance(0);
  expect(screen.getByText("Tap one NFC card at Front door for Casey Demo.")).toBeTruthy();
  expect((screen.getByLabelText("Card label") as HTMLInputElement).value).toBe("Spare fob");
  expect((screen.getByLabelText("Assignment reason") as HTMLInputElement).value).toBe("Verified ID");
});

test("clicking Replace again on the card already being replaced keeps the scan and what was typed", async () => {
  scanServer([card], () => ({ status: "captured", last4: "7788", assignments: [] }));
  render(<MemberCards userId={14} memberName="Casey Demo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace Blue fob" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start card scan" }));
  await screen.findByText("Card captured · ending 7788");
  typeAssignment();
  fireEvent.click(screen.getByRole("button", { name: "Replace Blue fob" }));
  await settle();
  expect(screen.getByText("Card captured · ending 7788")).toBeTruthy();
  expect((screen.getByLabelText("Card label") as HTMLInputElement).value).toBe("Spare fob");
  expect((screen.getByLabelText("Assignment reason") as HTMLInputElement).value).toBe("Verified ID");
  expect(assignButton("Confirm replacement").disabled).toBe(false);
  expect(cancels()).toBe(0);
});

test("revoking the card being replaced turns the replacement into a plain assignment without losing the scan", async () => {
  const list = [{ ...card }];
  change = () => { list[0] = { ...card, active: false, revision: 4 }; return Promise.resolve({}); };
  const save = vi.fn((_body: Record<string, unknown>) => Promise.resolve({}));
  scanServer(list, () => ({ status: "captured", last4: "7788", assignments: [] }), save);
  render(<MemberCards userId={14} memberName="Casey Demo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace Blue fob" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start card scan" }));
  await screen.findByText("Card captured · ending 7788");
  typeAssignment();
  fireEvent.click(screen.getByRole("button", { name: "Revoke Blue fob" }));
  const dialog = screen.getByRole("dialog", { name: "Revoke Blue fob?" });
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Lost card" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm revocation" }));
  expect((await screen.findByText(/Blue fob is no longer active/)).textContent).toContain("assigned without replacing it");
  expect(screen.getByRole("heading", { name: "Assign an NFC card" })).toBeTruthy();
  expect(screen.queryByText(/old card stays active/)).toBeNull();
  expect(screen.getByText("Card captured · ending 7788")).toBeTruthy();
  expect(cancels()).toBe(0);
  fireEvent.click(assignButton());
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({ userId: 14, label: "Spare fob", reason: "Verified ID", enrollmentId: "scan-1" });
});

test("a replacement refused because the old card changed retries with its latest revision", async () => {
  const list = [{ ...card }];
  const save = vi.fn((_body: Record<string, unknown>) => {
    if (save.mock.calls.length > 1) return Promise.resolve({});
    // Revoked and reactivated elsewhere: still active, at a newer revision.
    list[0] = { ...card, revision: 5 };
    return Promise.reject(new ApiError(409, "STALE_RECORD", "The card being replaced changed. Refresh and review it before trying again."));
  });
  scanServer(list, () => ({ status: "captured", last4: "7788", assignments: [] }), save);
  render(<MemberCards userId={14} memberName="Casey Demo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace Blue fob" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start card scan" }));
  await screen.findByText("Card captured · ending 7788");
  typeAssignment();
  fireEvent.click(assignButton("Confirm replacement"));
  await screen.findByText("The card being replaced changed. Refresh and review it before trying again.");
  await waitFor(() => expect(cardReads()).toBe(2));
  await settle();
  fireEvent.click(assignButton("Confirm replacement"));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.map(([body]) => body.expectedRevision)).toEqual([3, 5]);
  expect(save.mock.calls[1]![0]).toMatchObject({ replaceCardId: 5, label: "Spare fob", reason: "Verified ID" });
});
