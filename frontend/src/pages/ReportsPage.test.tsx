// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
