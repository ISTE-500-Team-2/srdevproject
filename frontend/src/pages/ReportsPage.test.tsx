// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComplianceSummary, ReportsPage } from "./ReportsPage";
import { useApi } from "../lib/useApi";

vi.mock("../lib/useApi", () => ({ useApi: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const compliance = { activeAccounts: 10, restrictedAccounts: 1, expiredTraining: 2, activeMemberships: 8, trainingWithoutExpiry: 3, signaturesWithoutCopy: 4, machinesWithoutTraining: ["Saw", "Drill"] };

test("B-013, B-014, B-016: records that need a decision are named for staff", () => {
  render(<ComplianceSummary compliance={compliance} />);
  expect(screen.getByText(/8 active memberships/)).toBeTruthy();
  expect(screen.getByText(/3 active training records have no expiry date/)).toBeTruthy();
  expect(screen.getByText(/4 signed waivers have no retained copy/)).toBeTruthy();
  expect(screen.getByText(/2 bookable machines have no training requirement: Saw, Drill/)).toBeTruthy();
});

test("nothing extra is shown when every record is in order", () => {
  render(<ComplianceSummary compliance={{ ...compliance, trainingWithoutExpiry: 0, signaturesWithoutCopy: 0, machinesWithoutTraining: [] }} />);
  expect(screen.queryByText(/no expiry date/)).toBeNull();
  expect(screen.queryByText(/no retained copy/)).toBeNull();
  expect(screen.queryByText(/no training requirement/)).toBeNull();
});

test("counts of one read in the singular", () => {
  render(<ComplianceSummary compliance={{ ...compliance, activeAccounts: 1, restrictedAccounts: 1, expiredTraining: 1 }} />);
  expect(screen.getByText(/1 active account · 1 restricted account · 1 expired active training record$/)).toBeTruthy();
});

test("check-in and room counts agree with their number, and a room without a capacity doesn't print a blank one", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T16:00:00Z"));
  const report = {
    from: "2026-11-10", to: "2026-11-10", period: "daily", timeZone: "America/New_York", generatedAt: "2026-11-10T16:00:00Z",
    revenue: [], classes: [], active: { approvedCheckIns: 1, activeUsers: 1 }, compliance, notes: [],
    equipment: [], live: [], memberships: [], patterns: [], usage: [],
    rooms: [
      { id: 1, name: "Room A", capacity: null, distinctVisitors: 1, recordedCheckIns: 1 },
      { id: 2, name: "Room B", capacity: 12, distinctVisitors: 2, recordedCheckIns: 3 },
    ],
  };
  vi.mocked(useApi).mockImplementation(((path: string) => ({
    data: path === "/config" ? { timeZone: "America/New_York" } : report,
    loading: false, refreshing: false, error: "", reload: vi.fn(),
  })) as never);
  render(<ReportsPage />);
  expect(screen.getByText("1 unique checked-in user · 1 approved check-in")).toBeTruthy();
  expect(screen.getByText("Room A: 1 visitor, 1 check-in")).toBeTruthy();
  expect(screen.getByText("Room B: 2 visitors, 3 check-ins; room capacity 12")).toBeTruthy();
});

/** The page at `now` with /config answering `config`; reports never arrive. */
function mountAt(now: string, config: { timeZone: string } | "loading" | "failed") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  vi.mocked(useApi).mockImplementation(((path: string) => path === "/config"
    ? { data: typeof config === "object" ? config : null, loading: config === "loading", refreshing: false, error: config === "failed" ? "Offline" : "", reload: vi.fn() }
    : { data: null, loading: true, refreshing: false, error: "", reload: vi.fn() }) as never);
  render(<ReportsPage />);
}
const reportPaths = () => vi.mocked(useApi).mock.calls.map(([path]) => path).filter((path) => path?.startsWith("/admin/reports"));

test("the report waits for the facility zone before choosing today", () => {
  mountAt("2026-11-11T03:00:00Z", "loading");
  expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
  expect(screen.queryByLabelText("From")).toBeNull();
  expect(reportPaths()).toEqual([]);
});

test("today is the facility's day from /config, falling back to New York when it can't be read", () => {
  // 03:00 UTC on Nov 11 is still Nov 10 in New York but already Nov 11 in Auckland.
  mountAt("2026-11-11T03:00:00Z", { timeZone: "Pacific/Auckland" });
  expect(reportPaths()).toContain("/admin/reports?from=2026-11-11&to=2026-11-11&period=daily");
  expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-11-11");
  cleanup();
  vi.mocked(useApi).mockReset();
  mountAt("2026-11-11T03:00:00Z", "failed");
  expect(reportPaths()).toEqual(expect.arrayContaining(["/admin/reports?from=2026-11-10&to=2026-11-10&period=daily"]));
  expect(reportPaths().filter((path) => path?.includes("2026-11-11"))).toEqual([]);
});

test("new dates keep the last report on screen, out of reach, while the date form stays usable", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T16:00:00Z"));
  const report = {
    from: "2026-11-10", to: "2026-11-10", period: "daily", timeZone: "America/New_York", generatedAt: "2026-11-10T16:00:00Z",
    revenue: [], classes: [], active: { approvedCheckIns: 0, activeUsers: 0 }, compliance, notes: [],
    equipment: [], live: [], memberships: [], patterns: [], rooms: [], usage: [],
  };
  let stale = false;
  vi.mocked(useApi).mockImplementation(((path: string) => ({
    data: path === "/config" ? { timeZone: "America/New_York" } : report,
    loading: false,
    refreshing: false,
    stale: path !== "/config" && stale,
    error: "",
    reload: vi.fn(),
  })) as never);
  render(<ReportsPage />);
  expect(vi.mocked(useApi).mock.calls.find(([path]) => path?.startsWith("/admin/reports"))?.[1]).toMatchObject({ retainOnChange: true });
  stale = true;
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply dates" }).closest("form")!);
  expect(vi.mocked(useApi).mock.lastCall?.[0]).toContain("from=2026-11-01");
  const results = document.querySelector(".kept-results")!;
  expect(results.hasAttribute("inert")).toBe(true);
  expect(results.textContent).toContain("Recorded revenue");
  expect(results.contains(screen.getByLabelText("From"))).toBe(false);
});
