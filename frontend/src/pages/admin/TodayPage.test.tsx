// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TodayPage } from "./TodayPage";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", () => ({ api, ApiError: class extends Error {}, errorMessage: (error: Error) => error.message }));
const people = Array.from({ length: 7 }, (_, i) => ({ userId: i + 1, name: `Member ${i + 1}`, location: "Wood shop", at: "2026-10-28T07:30:00Z", method: i ? "portal" : "nfc" }));
let fail = "";
beforeEach(() => {
  fail = "";
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T07:30:00Z"));
  api.mockImplementation((path: string) => {
    if (path === fail) return Promise.reject(new Error("Equipment request failed"));
    if (path === "/config") return Promise.resolve({ timeZone: "Asia/Kolkata" });
    if (path.startsWith("/admin/reports?")) return Promise.resolve({ checkedInTodayCount: 7, checkedInToday: people, live: [{ kind: "equipment", resourceId: 1, activeReaderLeases: 2 }, { kind: "room", resourceId: 2, activeReaderLeases: 1 }], classes: [{ id: 1, title: "Woodworking", startsAt: "2026-10-28T10:30:00Z", capacity: 8, enrolled: 6 }] });
    if (path === "/equipment") return Promise.resolve([{ id: 1, name: "Lathe", type: "Wood", status: "available", image: "" }]);
    if (path.startsWith("/admin/reservations?")) return Promise.resolve({ items: [], nextOffset: null });
    if (path === "/studios") return Promise.resolve({ studios: [{ id: 1, name: "Studio A", size: "Small", availability: [{ starts_on: "2026-10-01", ends_on: "2026-11-01", status: "confirmed", hold_until: "" }] }, { id: 2, name: "Studio B", size: "Large", availability: [] }] });
    if (path === "/studio-management/rentals") return Promise.resolve([{ id: 1, name: "Studio A", email: "artist@example.test", status: "confirmed", starts_on: "2026-10-01", ends_on: "2026-11-01" }]);
    if (path.startsWith("/admin/compliance?")) return Promise.resolve({ summary: { userCount: 7, waiverCompliantUsers: 7, certificationCompliantUsers: 7 } });
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const mount = () => render(<MemoryRouter><TodayPage /></MemoryRouter>);
test("machine details and actual outage intervals remain available after restoration", async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path === "/equipment" ? Promise.resolve([
    { id: 9, name: "Restored machine", type: "Wood", status: "available", image: "", outages: [
      { startedAt: "2026-10-28T04:30:00Z", endedAt: "2026-10-28T07:30:00Z", reason: "repair", expectedBack: null },
    ] },
  ]) : original(path));
  mount();
  const link = await screen.findByRole("link", { name: "Restored machine" });
  expect(link.getAttribute("href")).toBe("/admin/equipment/9");
  const track = await screen.findByRole("list", { name: "Restored machine bookings today" });
  const outage = track.querySelector<HTMLElement>(".today-outage")!;
  expect(Number.parseFloat(outage.style.left)).toBeCloseTo(100 / 12);
  expect(outage.style.width).toBe("25%");
});
test("renders header counts from reports and times in the configured zone", async () => {
  mount();
  expect(await screen.findByText("Wednesday, October 28")).toBeTruthy();
  expect(await screen.findByText("7 people checked in today, 1 machine running.")).toBeTruthy();
  expect(await screen.findByText("4:00 PM")).toBeTruthy();
  expect(screen.getAllByText("1:00 PM")).toHaveLength(6);
  expect(api.mock.calls.some(([p]) => p === "/admin/reports?period=daily&from=2026-10-28&to=2026-10-28")).toBe(true);
  expect(await screen.findByText("In use")).toBeTruthy();
  expect(await screen.findByText("1 of 2 rented")).toBeTruthy();
  expect(screen.getByText("Available")).toBeTruthy();
  // Renters' contact details never show on the dashboard.
  expect(screen.queryByText("artist@example.test")).toBeNull();
});
test("one endpoint failure leaves other panels and the header intact", async () => {
  fail = "/equipment"; mount();
  expect((await screen.findAllByText(/Equipment request failed/)).length).toBeGreaterThan(0);
  expect(await screen.findByText("Studio A")).toBeTruthy();
  expect(screen.getByText("Woodworking")).toBeTruthy();
  expect(screen.getByText("Member 1")).toBeTruthy();
  expect(screen.getByText(/7 people checked in today/)).toBeTruthy();
});
test("Show all expands and collapses the check-in list", async () => {
  mount(); const button = await screen.findByRole("button", { name: "Show all 7" });
  expect(screen.queryByText("Member 7")).toBeNull(); fireEvent.click(button);
  expect(screen.getByText("Member 7")).toBeTruthy(); expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" })); expect(screen.queryByText("Member 7")).toBeNull();
});
test("renders needs-you empty state only when its data has loaded", async () => {
  mount(); expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
});
test("follows reservation pagination before building the floor", async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.startsWith("/admin/reservations?") ? Promise.resolve(path.includes("offset=50") ? { items: [{ id: 2, equipmentId: 1, memberName: "Dana Whitfield", startTime: "2026-10-28T07:00:00Z", endTime: "2026-10-28T09:00:00Z", status: "confirmed" }], nextOffset: null } : { items: [], nextOffset: 50 }) : original(path));
  mount(); await waitFor(() => expect(screen.getByRole("listitem", { name: "Dana Whitfield, 12:30 PM to 2:30 PM, in use now" })).toBeTruthy());
  expect(within(screen.getByRole("region", { name: "On the floor" })).getByText("In use until 2:30 PM")).toBeTruthy();
});
test("config failure does not send requests with a guessed date", async () => {
  fail = "/config"; mount(); await screen.findAllByText(/Equipment request failed/);
  expect(api.mock.calls.some(([p]) => p.startsWith("/admin/reports?") || p.startsWith("/admin/reservations?"))).toBe(false);
});
test("requests each endpoint once, and only after /config gives the day", async () => {
  const original = api.getMockImplementation()!;
  let resolveConfig!: (value: { timeZone: string }) => void;
  api.mockImplementation((path: string) => path === "/config"
    ? new Promise((resolve) => { resolveConfig = resolve; })
    : original(path));
  mount();
  await waitFor(() => expect(api).toHaveBeenCalledWith("/config"));
  // Mounting the panels before the day is known would read everything twice.
  expect(api.mock.calls.map(([p]) => p)).toEqual(["/config"]);
  resolveConfig({ timeZone: "Asia/Kolkata" });
  expect(await screen.findByText("7 people checked in today, 1 machine running.")).toBeTruthy();
  expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
  expect(api.mock.calls.map(([p]) => p).sort()).toEqual([
    "/config", "/equipment", "/studios", "/studio-management/rentals", "/admin/compliance?userStatus=active&attention=true",
    "/admin/reports?period=daily&from=2026-10-28&to=2026-10-28",
    "/admin/reservations?date=2026-10-28",
  ].sort());
});
test("at midnight every panel starts the new day, so a failed refresh is not hidden by yesterday's data", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  // 23:59 in Kolkata (UTC+5:30); everyone compliant.
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-28T18:29:00Z"));
  mount();
  expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
  // After midnight a waiver has expired, but the compliance read fails.
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-28T18:31:00Z"));
  fail = "/admin/compliance?userStatus=active&attention=true";
  await act(async () => { vi.advanceTimersByTime(60000); });
  expect(await screen.findByText(/Equipment request failed/)).toBeTruthy();
  expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
  expect(api.mock.calls.map(([p]) => p)).toContain("/admin/reports?period=daily&from=2026-10-29&to=2026-10-29");
  vi.useRealTimers();
});
test("a failed background refresh keeps every panel's data and offers one reload", async () => {
  mount();
  expect(await screen.findByRole("link", { name: "Lathe" })).toBeTruthy();
  expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
  expect(screen.queryByText(/could not be refreshed/)).toBeNull();
  fail = "/equipment";
  const before = api.mock.calls.filter(([p]) => p === "/equipment").length;
  await act(async () => { fireEvent.focus(window); });
  const stale = await screen.findByText(/Some of today’s information could not be refreshed/);
  expect(stale.textContent).toContain("Equipment request failed");
  expect(stale.getAttribute("role")).toBe("status");
  // The older data stays on screen; no panel switches to its error state.
  expect(screen.getByRole("link", { name: "Lathe" })).toBeTruthy();
  expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fail = "";
  const reloads = api.mock.calls.length;
  fireEvent.click(within(stale).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
  // Only the failed source is read again.
  expect(api.mock.calls.slice(reloads).map(([p]) => p)).toEqual(["/equipment"]);
  expect(api.mock.calls.filter(([p]) => p === "/equipment").length).toBeGreaterThan(before + 1);
  expect(screen.getByRole("link", { name: "Lathe" })).toBeTruthy();
});
test("the stale notice stays up while a retry is still running", async () => {
  mount();
  expect(await screen.findByRole("link", { name: "Lathe" })).toBeTruthy();
  fail = "/equipment";
  await act(async () => { fireEvent.focus(window); });
  const stale = await screen.findByText(/Some of today’s information could not be refreshed/);
  // The retry never settles; useApi clears its error while it runs.
  fail = "";
  const original = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path === "/equipment" ? new Promise(() => {}) : original(path));
  await act(async () => { fireEvent.click(within(stale).getByRole("button", { name: "Reload" })); });
  expect(screen.getByText(/Some of today’s information could not be refreshed/).textContent).toContain("Equipment request failed");
  expect(screen.getByRole("link", { name: "Lathe" })).toBeTruthy();
});

test("a failed bookings refresh is reported while the bookings stay on the floor", async () => {
  const original = api.getMockImplementation()!;
  let bookingsFail = false;
  api.mockImplementation((path: string) => path.startsWith("/admin/reservations?")
    ? bookingsFail
      ? Promise.reject(new Error("Bookings request failed"))
      : Promise.resolve({ items: [{ id: 2, equipmentId: 1, memberName: "Dana Whitfield", startTime: "2026-10-28T07:00:00Z", endTime: "2026-10-28T09:00:00Z", status: "confirmed" }], nextOffset: null })
    : original(path));
  mount();
  const booking = { name: "Dana Whitfield, 12:30 PM to 2:30 PM, in use now" };
  expect(await screen.findByRole("listitem", booking)).toBeTruthy();
  bookingsFail = true;
  await act(async () => { fireEvent.focus(window); });
  const stale = await screen.findByText(/Some of today’s information could not be refreshed/);
  expect(stale.textContent).toContain("Bookings request failed");
  expect(stale.getAttribute("role")).toBe("status");
  expect(screen.getByRole("listitem", booking)).toBeTruthy();
  bookingsFail = false;
  const reloads = api.mock.calls.length;
  fireEvent.click(within(stale).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
  expect(api.mock.calls.slice(reloads).map(([p]) => p)).toEqual(["/admin/reservations?date=2026-10-28"]);
  expect(screen.getByRole("listitem", booking)).toBeTruthy();
});
test("a first-load failure stays in its panel and adds no stale notice", async () => {
  fail = "/equipment"; mount();
  expect((await screen.findAllByText(/Equipment request failed/)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/could not be refreshed/)).toBeNull();
});
