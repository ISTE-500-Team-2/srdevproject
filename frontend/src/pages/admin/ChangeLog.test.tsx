// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChangeLog } from "./ChangeLog";
import type { Audit, AuditPage, AuditRecord } from "../../lib/staffContracts";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../../lib/useApi", () => ({ useApi }));
vi.mock("../../components/MemberSelect", () => ({
  MemberSelect: ({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) => (
    <label>
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  ),
}));

const base = { actorId: 2, actorName: "Alex Demo", subjectId: null, entityId: 8, subjectName: null };
const items: Audit[] = [
  { ...base, id: "42", action: "service_notice.resolved", entityType: "app_service_notice", createdAt: "2026-11-11T23:11:09Z", resourceName: "Dust collector down" },
  { ...base, id: "7", actorId: null, actorName: "System", subjectId: 14, subjectName: "Casey Demo", action: "app_device_access_event.insert", entityType: "app_device_access_event", allowed: false, accessReason: "ACCOUNT_BLOCKED", resourceName: "3D Printer", createdAt: "2026-11-10T17:27:00Z" },
];
const record: AuditRecord = {
  ...items[0],
  reason: "New filter bags fitted.",
  source: "application",
  changes: {
    changed: [{ field: "resolution", before: null, after: "New filter bags fitted." }],
    unchanged: [{ field: "summary", before: "Dust collector down", after: "Dust collector down" }],
  },
  related: [{ id: "41", action: "app_service_notice.update", entityType: "app_service_notice", entityId: 8, source: "database" }],
  relatedCount: 1,
};
let page: AuditPage;
const calls = () => useApi.mock.calls.map(([path]) => path as string | null);
const lists = () => calls().filter((path): path is string => !!path?.startsWith("/admin/audit?")).map((path) => new URLSearchParams(path.split("?")[1]));
const show = () =>
  render(
    <MemoryRouter>
      <ChangeLog />
    </MemoryRouter>,
  );

beforeEach(() => {
  page = { items, nextOffset: null, counts: { staff: 1, taps: 1, database: 3 } };
  useApi.mockImplementation((path: string | null) => {
    const loaded = (data: unknown) => ({ data, loading: false, refreshing: false, error: "", reload: vi.fn() });
    if (path === "/config") return loaded({ timeZone: "America/New_York" });
    if (path === "/admin/audit/actions") return loaded(["equipment.updated", "service_notice.resolved", "user.role_changed"]);
    if (path?.startsWith("/admin/audit?")) return loaded(page);
    if (path === "/admin/audit/42") return loaded(record);
    return loaded(null);
  });
});
afterEach(() => {
  cleanup();
  useApi.mockReset();
  vi.useRealTimers();
});

test("opens on staff actions from the last 7 days, with every view's total", () => {
  show();
  const first = lists()[0];
  expect(first.get("view")).toBe("staff");
  expect(first.get("offset")).toBe("0");
  // Seven facility days back, at local midnight.
  const days = (Date.now() - Date.parse(first.get("from")!)) / 86400000;
  expect(days).toBeGreaterThan(6);
  expect(days).toBeLessThan(7.1);
  expect(screen.getByText("1 staff action").parentElement!.textContent).toBe("1 staff action in the last 7 days.");
  const views = screen.getByRole("group", { name: "Show" });
  expect(within(views).getByRole("button", { name: "3 Database writes" })).toBeTruthy();
  expect(within(views).getByRole("button", { name: "1 Staff actions" }).getAttribute("aria-pressed")).toBe("true");
});

test("rows say what happened, to what, and by whom", () => {
  show();
  expect(screen.getByText("Service notice resolved")).toBeTruthy();
  expect(screen.getByText("Dust collector down")).toBeTruthy();
  expect(screen.getByText("By Alex Demo")).toBeTruthy();
  expect(screen.getByText("Card tap denied")).toBeTruthy();
  expect(screen.getByText("Casey Demo · 3D Printer")).toBeTruthy();
  expect(screen.getByText("Automatic")).toBeTruthy();
  expect(screen.getByText("Showing 1–2 of 1")).toBeTruthy();
});

test("views, periods, people and areas become request filters", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "3 Database writes" }));
  expect(lists().at(-1)!.get("view")).toBe("database");
  fireEvent.click(screen.getByRole("button", { name: "All time" }));
  expect(lists().at(-1)!.has("from")).toBe(false);
  fireEvent.change(screen.getByLabelText("Changed by"), { target: { value: "2" } });
  expect(lists().at(-1)!.get("actorId")).toBe("2");
  fireEvent.click(screen.getByLabelText("Equipment"));
  expect(lists().at(-1)!.get("actions")).toBe("equipment.updated");
  fireEvent.click(screen.getByLabelText("Notices & email"));
  expect(lists().at(-1)!.get("actions")).toBe("equipment.updated,service_notice.resolved");
  fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
  const cleared = lists().at(-1)!;
  expect(cleared.has("actions") || cleared.has("actorId")).toBe(false);
  expect(cleared.get("view")).toBe("database");
});

test("search waits for typing to settle", () => {
  vi.useFakeTimers();
  show();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: " bandsaw " } });
  expect(lists().at(-1)!.has("search")).toBe(false);
  act(() => vi.advanceTimersByTime(300));
  expect(lists().at(-1)!.get("search")).toBe("bandsaw");
});

test("a record shows its reason, the fields that changed and what was saved with it", () => {
  show();
  fireEvent.click(screen.getByText("Service notice resolved"));
  expect(calls()).toContain("/admin/audit/42");
  const panel = screen.getByRole("complementary", { name: "Change details" });
  expect(within(panel).getByRole("heading", { name: "Service notice resolved" })).toBeTruthy();
  expect(within(panel).getByText("New filter bags fitted.", { selector: ".cl-quote" })).toBeTruthy();
  expect(within(panel).getByText("Resolution")).toBeTruthy();
  expect(within(panel).getByText("Not set")).toBeTruthy();
  expect(within(panel).getByText("1 of 2 fields")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Service notice updated" }));
  expect(calls()).toContain("/admin/audit/41");
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Change details" })).toBeNull();
});

test("closing a record returns focus to the row that opened it", async () => {
  show();
  const row = screen.getByText("Service notice resolved").closest("button")!;
  fireEvent.click(row);
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(document.activeElement).toBe(row);
});

test("an empty view points to the views that do have matches", () => {
  page = { items: [], nextOffset: null, counts: { staff: 0, taps: 0, database: 3 } };
  show();
  expect(screen.getByText("No staff actions in the last 7 days.")).toBeTruthy();
  expect(screen.getByText("3 database writes do.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show database writes" }));
  expect(lists().at(-1)!.get("view")).toBe("database");
  fireEvent.click(screen.getByRole("button", { name: "Look further back" }));
  expect(lists().at(-1)!.has("from")).toBe(true);
});
