// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
