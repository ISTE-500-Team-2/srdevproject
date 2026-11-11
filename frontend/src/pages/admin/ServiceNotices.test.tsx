// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ServiceNotices } from "./ServiceNotices";
import { useApi } from "../../lib/useApi";
import { api } from "../../lib/api";
import type { ServiceNotice, ServiceNoticePage } from "../../lib/serviceNotices";

const auth = vi.hoisted(() => ({ user: { roles: ["admin"] } }));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../../lib/useApi", () => ({ useApi: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({ ...(await original<typeof import("../../lib/api")>()), api: vi.fn() }));

const NOW = Date.parse("2026-11-05T17:02:00Z"); // 12:02 PM in New York
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  auth.user.roles = ["admin"];
});

const base: ServiceNotice = {
  id: 1, source: "staff", readerId: null, summary: "", openedAt: "", resolvedAt: null, recipients: null, resolution: null,
  openedBy: null, resolvedBy: null, readerName: null, readerLastSeenAt: null, recentDrops: null,
};
const announcement: ServiceNotice = {
  ...base, id: 4, summary: "The laser cutter is out of service.", openedAt: "2026-11-05T15:00:00Z", recipients: 214, openedBy: "Sam Rivera",
};
const offline: ServiceNotice = {
  ...base, id: 5, source: "reader", readerId: "c3", summary: "C3 Mini has stopped reporting in.", readerName: "C3 Mini",
  openedAt: "2026-11-05T16:20:00Z", readerLastSeenAt: "2026-11-05T16:15:00Z", recipients: 6, recentDrops: 4,
};
const drop = (id: number, opened: string, resolved: string): ServiceNotice => ({
  ...offline, id, openedAt: opened, resolvedAt: resolved, recentDrops: null,
});
const reload = vi.fn();
let requested: (string | null)[] = [];
const mount = (page: Partial<ServiceNoticePage> = {}, audience = 214) => {
  requested = [];
  const data: ServiceNoticePage = { open: [], items: [], nextOffset: null, total: 0, ...page };
  vi.mocked(useApi).mockImplementation(((path: string | null) => {
    requested.push(path);
    const result = (value: unknown) => ({ data: value, loading: false, refreshing: false, error: "", reload });
    if (path === "/config") return result({ timeZone: "America/New_York" });
    if (path === "/admin/service-notices/audience") return result({ recipients: audience });
    if (path?.startsWith("/admin/service-notices?")) return result(data);
    return result(null);
  }) as never);
  render(<MemoryRouter><ServiceNotices /></MemoryRouter>);
};
const compose = (summary: string, note = "") => {
  fireEvent.click(screen.getByRole("button", { name: "Tell members about a problem" }));
  const dialog = screen.getByRole("dialog", { name: "Tell members about a problem" });
  fireEvent.change(within(dialog).getByLabelText("What members should know"), { target: { value: summary } });
  if (note) fireEvent.change(within(dialog).getByLabelText(/Note for the change log/), { target: { value: note } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review email" }));
  return screen.getByRole("dialog", { name: "Email every member?" });
};

test("FR-032: an administrator previews the email and its reach before it goes to everyone", async () => {
  vi.mocked(api).mockResolvedValue({ recipients: 214 } as never);
  mount();
  const dialog = compose("The north door is down.", "Front desk report");
  expect(api).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText("Email preview").textContent).toContain("The north door is down.");
  expect(dialog.textContent).toContain("Goes to 214 people who get notifications.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/service-notices", {
      method: "POST",
      body: { summary: "The north door is down.", reason: "Front desk report" },
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("status").textContent).toContain("Sent to 214 people.");
  expect(reload).toHaveBeenCalled();
});

test("FR-032: the change-log note is optional and a too-short message cannot be reviewed", async () => {
  vi.mocked(api).mockResolvedValue({ recipients: 3 } as never);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Tell members about a problem" }));
  const write = screen.getByRole("dialog", { name: "Tell members about a problem" });
  fireEvent.change(within(write).getByLabelText("What members should know"), { target: { value: "Shh" } });
  expect((within(write).getByRole("button", { name: "Review email" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(write).getByRole("button", { name: "Cancel" }));
  const dialog = compose("Closing at 3 PM today.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/service-notices", { method: "POST", body: { summary: "Closing at 3 PM today." } }),
  );
});

test("FR-032: an offline reader shows how long, who was told, and where to check it", () => {
  mount({ open: [offline, announcement] });
  expect(screen.getByText(/2 problems open: C3 Mini has been offline for 42 min\./)).toBeTruthy();
  const now = screen.getByRole("region", { name: "Happening now" });
  expect(now.textContent).toContain("Offline 42 min · last seen 11:15 AM");
  expect(now.textContent).toContain("Dropped out 4 times in the last 24 hours.");
  expect(now.textContent).toContain("Emailed 6 staff");
  expect(now.textContent).toContain("Emailed 214 people");
  expect(now.textContent).toContain("Sent by Sam Rivera · 2 h 02 min ago");
  expect(within(now).getByRole("link", { name: "Check reader" }).getAttribute("href")).toBe("/admin/access?view=readers");
  // Only the announcement can be marked fixed; the reader clears itself.
  expect(within(now).getAllByRole("button", { name: /^Mark fixed/ })).toHaveLength(1);
});

test("FR-032: a reader that drops out rarely is not flagged", () => {
  mount({ open: [{ ...offline, recentDrops: 1 }] });
  expect(screen.queryByText(/Dropped out/)).toBeNull();
});

test("FR-032: marking an announcement fixed sends what was fixed to everyone", async () => {
  vi.mocked(api).mockResolvedValue({} as never);
  mount({ open: [announcement] });
  fireEvent.click(screen.getByRole("button", { name: "Mark fixed: The laser cutter is out of service." }));
  const dialog = screen.getByRole("dialog", { name: "Tell everyone it's fixed?" });
  fireEvent.change(within(dialog).getByLabelText("What was fixed"), { target: { value: "Fan replaced" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/service-notices/4/resolve", { method: "POST", body: { message: "Fan replaced" } }),
  );
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Told everyone it's fixed."));
});

test("FR-032: staff can see notices but only administrators can send them", () => {
  auth.user.roles = ["staff"];
  mount({ open: [announcement] });
  expect(screen.getByText("The laser cutter is out of service.")).toBeTruthy();
  expect(screen.getByText("Only administrators can email members.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Tell members about a problem" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Mark fixed/ })).toBeNull();
});

test("FR-032: a reader's drop-outs on one day share a history row that expands to each one", () => {
  mount({
    items: [
      drop(13, "2026-11-05T14:59:00Z", "2026-11-05T14:59:30Z"),
      drop(12, "2026-11-05T14:43:00Z", "2026-11-05T14:48:00Z"),
      drop(11, "2026-11-05T14:32:00Z", "2026-11-05T14:36:00Z"),
      { ...announcement, id: 9, openedAt: "2026-11-03T19:10:00Z", resolvedAt: "2026-11-03T21:15:00Z", resolvedBy: "Sam Rivera", resolution: "HVAC is fixed." },
    ],
    total: 4,
  });
  const table = screen.getByRole("region", { name: "Past notices" });
  // Each history row is followed by its detail row, hidden until it is expanded.
  const rows = [table.querySelector("thead tr"), ...table.querySelectorAll("tbody > tr")] as HTMLTableRowElement[];
  expect(rows).toHaveLength(5);
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  const reader = within(table).getByRole("button", { name: "C3 Mini" });
  expect(rows[1]!.textContent).toContain("3 drop-outs");
  expect(rows[1]!.textContent).toContain("Nov 5");
  expect(rows[1]!.textContent).toContain("9:32 AM");
  expect(rows[1]!.textContent).toContain("9 min");
  expect(rows[2]!.hidden).toBe(true);
  fireEvent.click(reader);
  expect(reader.getAttribute("aria-expanded")).toBe("true");
  expect(rows[2]!.hidden).toBe(false);
  expect(rows[2]!.textContent).toContain("9:43 AM – 9:48 AM");
  expect(rows[3]!.textContent).toContain("214 people");
  expect(rows[3]!.textContent).toContain("2 h 05 min");
  expect(rows[3]!.textContent).toContain("“HVAC is fixed.”");
  expect(screen.getByText("4 notices in the past 30 days")).toBeTruthy();
});

test("FR-032: changing a history filter asks for that period and source from the first page", () => {
  mount();
  fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7d" } });
  fireEvent.change(screen.getByLabelText("Source"), { target: { value: "reader" } });
  expect(requested).toContain("/admin/service-notices?period=7d&offset=0&source=reader");
  expect(screen.getByText(/No problems were recorded in the past 7 days from this source\./)).toBeTruthy();
});

test("FR-032: a failed send keeps its error in that dialog only", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Could not send"));
  mount({ open: [announcement] });
  const dialog = compose("Another problem here.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  fireEvent.click(screen.getByRole("button", { name: /^Mark fixed/ }));
  expect(within(screen.getByRole("dialog", { name: "Tell everyone it's fixed?" })).queryByRole("alert")).toBeNull();
});

test("FR-032: while a send is running the draft is locked, so a late reply cannot wipe new edits", async () => {
  let finish = (_: unknown) => {};
  vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
  mount();
  const dialog = compose("Another problem here.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to everyone" }));
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect((within(dialog).getByRole("button", { name: "Keep editing" }) as HTMLButtonElement).disabled).toBe(true);
  finish({ recipients: 1 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
