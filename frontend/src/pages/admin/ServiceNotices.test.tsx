// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ServiceNotices } from "./ServiceNotices";
import { useApi } from "../../lib/useApi";
import { api } from "../../lib/api";

const auth = vi.hoisted(() => ({ user: { roles: ["admin"] } }));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../../lib/useApi", () => ({ useApi: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({ ...(await original<typeof import("../../lib/api")>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); auth.user.roles = ["admin"]; });

const manual = { id: 4, source: "staff", readerId: null, summary: "The north door is down.", openedAt: "2026-11-04T15:00:00Z", resolvedAt: null };
const automatic = { id: 5, source: "reader", readerId: "door-1", summary: "North door has stopped reporting in.", openedAt: "2026-11-04T15:10:00Z", resolvedAt: null };
const reload = vi.fn();
const mount = (items: unknown[] = []) => {
  vi.mocked(useApi).mockReturnValue({ data: items, loading: false, refreshing: false, error: "", reload } as never);
  render(<ServiceNotices />);
};

test("FR-032: an administrator confirms before a notice goes to everyone", async () => {
  vi.mocked(api).mockResolvedValue({} as never);
  mount();
  fireEvent.change(screen.getByLabelText("What members should know"), { target: { value: "The north door is down." } });
  fireEvent.change(screen.getByLabelText("Reason for the change log"), { target: { value: "Front desk report" } });
  fireEvent.click(screen.getByRole("button", { name: "Review notice" }));
  expect(api).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Email every member?" });
  expect(dialog.textContent).toContain("The north door is down.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/admin/service-notices", { method: "POST", body: { summary: "The north door is down.", reason: "Front desk report" } }));
  await waitFor(() => expect(reload).toHaveBeenCalled());
});

test("FR-032: an open manual notice can be resolved; an automatic one clears itself", async () => {
  vi.mocked(api).mockResolvedValue({} as never);
  mount([manual, automatic]);
  expect(screen.getByText(/clears on its own when the reader reconnects/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Mark fixed/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Mark fixed: The north door is down." }));
  const dialog = screen.getByRole("dialog", { name: "Tell everyone it's fixed?" });
  fireEvent.change(within(dialog).getByLabelText("What was fixed"), { target: { value: "Reader replaced" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/admin/service-notices/4/resolve", { method: "POST", body: { reason: "Reader replaced" } }));
});

test("FR-032: staff can see notices but only administrators can send them", () => {
  auth.user.roles = ["staff"];
  mount([manual]);
  expect(screen.getByText("The north door is down.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review notice" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Mark fixed/ })).toBeNull();
});
