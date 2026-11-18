// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ComplianceSummary, ReportsPage } from "./ReportsPage";
import type { Report } from "../lib/reportContracts";
import { useApi } from "../lib/useApi";
import { zoneName } from "../lib/analytics";

vi.mock("../lib/useApi", () => ({ useApi: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
const config = { data: { timeZone: "America/New_York" }, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() };
const compliance = { activeAccounts: 10, restrictedAccounts: 1, expiredTraining: 2, activeMemberships: 8, trainingWithoutExpiry: 3, signaturesWithoutCopy: 4, machinesWithoutTraining: ["Saw", "Drill"] };

test("B-013, B-014, B-016: records that need a decision are named for staff", () => {
  render(<ComplianceSummary compliance={compliance} />);
  expect(screen.getByText(/8 active memberships/)).toBeTruthy();
  expect(screen.getByText(/3 active training records never expire\. Add an expiry date/)).toBeTruthy();
  expect(screen.getByText(/4 signed waivers are missing their saved copy/)).toBeTruthy();
  expect(screen.getByText("2 bookable machines have no training requirement: Saw, Drill.")).toBeTruthy();
  expect(screen.getByText("1 account is restricted.")).toBeTruthy();
});

test("counts of one read in the singular", () => {
  render(<ComplianceSummary compliance={{ ...compliance, activeAccounts: 1, restrictedAccounts: 1, expiredTraining: 1 }} />);
  expect(screen.getByText("1 account is restricted.")).toBeTruthy();
  expect(screen.getByText("1 expired training record is still marked active.")).toBeTruthy();
  expect(screen.getByText("8 active memberships, 1 active account")).toBeTruthy();
});

test("nothing extra is shown when every record is in order", () => {
  render(
    <ComplianceSummary
      compliance={{ ...compliance, restrictedAccounts: 0, expiredTraining: 0, trainingWithoutExpiry: 0, signaturesWithoutCopy: 0, machinesWithoutTraining: [] }}
    />,
  );
  expect(screen.getByText("All clear.")).toBeTruthy();
  expect(screen.getByText("8 active memberships, 10 active accounts, no restricted accounts, no expired training")).toBeTruthy();
  expect(screen.queryByText(/never expire/)).toBeNull();
  expect(screen.queryByText(/saved copy/)).toBeNull();
  expect(screen.queryByText(/no training requirement/)).toBeNull();
});

const cohort = { eligible: 0, on_time: 0, onTimePercent: null, delivered: 0, delivery_on_time: 0, deliveryOnTimePercent: null, delivery_failed: 0, failed: 0, uncertain: 0, pending: 0 };
function report(overrides: Partial<Report> = {}): Report {
  return {
    period: "weekly",
    from: "2026-09-01",
    to: "2026-09-30",
    timeZone: "America/New_York",
    generatedAt: "2026-09-30T20:00:00Z",
    notes: [],
    revenue: [
      { period: "2026-08-31", category: "Monthly membership", method: "card", receipts: 2, gross: "90.00", refunds: "0.00", net: "90.00" },
      { period: "2026-08-31", category: "Studio rental", method: "cash", receipts: 1, gross: "125.50", refunds: "0.00", net: "125.50" },
    ],
    equipment: [
      { id: 1, name: "Laser", bookedHours: 4, bookedUtilizationPercent: 2, reservations: 2 },
      { id: 2, name: "Lathe", bookedHours: 0, bookedUtilizationPercent: 0, reservations: 0 },
    ],
    patterns: [],
    classes: [],
    rooms: [],
    active: { activeUsers: 3, approvedCheckIns: 12 },
    visitsByDay: [],
    checkedInToday: [],
    checkedInTodayCount: 0,
    compliance: { ...compliance, restrictedAccounts: 0, expiredTraining: 0, trainingWithoutExpiry: 0, signaturesWithoutCopy: 0, machinesWithoutTraining: [] },
    live: [{ kind: "equipment", resourceId: 1, activeReaderLeases: 2 }],
    usage: [],
    memberships: [{ period: "2026-08-31", newMembers: 2, activeMembers: 5, expiringMembers: 0, cancelledMembers: 0 }],
    notifications: { cohorts: { membershipExpiration: { ...cohort, eligible: 4, delivery_on_time: 3, deliveryOnTimePercent: 75 } } },
    ...overrides,
  };
}

function mount(path: string, current: Report, previous: Report) {
  vi.mocked(useApi).mockImplementation(((url: string) => {
    if (url === "/config") return config;
    const asked = new URLSearchParams(url.split("?")[1]);
    const data = asked.get("from") === current.from ? current : asked.get("from") === previous.from ? previous : null;
    return { data, loading: !data, refreshing: false, stale: false, error: "", reload: vi.fn() };
  }) as never);
  render(
    <MemoryRouter initialEntries={[path]}>
      <ReportsPage />
    </MemoryRouter>,
  );
}

test("the range comes from the link, and each headline is compared with the period before", () => {
  const current = report();
  const previous = report({ from: "2026-08-02", to: "2026-08-31", revenue: [], memberships: [], active: { activeUsers: 1, approvedCheckIns: 4 } });
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", current, previous);
  expect((screen.getByRole("combobox", { name: "Date range" }) as HTMLSelectElement).value).toBe("custom");
  expect(screen.getByRole("radio", { name: "Weekly" }).getAttribute("aria-checked")).toBe("true");
  const cards = screen.getByLabelText("Totals for this period");
  expect(within(cards).getByText("$215.50")).toBeTruthy();
  expect(within(cards).getByText(/\$0\.00 in the previous 30 days/)).toBeTruthy();
  expect(within(cards).getByText(/\+8 vs the previous 30 days/)).toBeTruthy();
  expect(within(cards).getByText("75%")).toBeTruthy();
  expect(within(cards).getByText("3 of 4 arrived on time")).toBeTruthy();
});

test("each period is named once, machines nobody used wait behind a toggle, and live readers are named", () => {
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report(), report({ from: "2026-08-02", to: "2026-08-31" }));
  const revenue = screen.getByRole("region", { name: "Revenue" });
  const cells = within(revenue).getAllByText((_, el) => el?.tagName === "TD" && el.textContent!.startsWith("Week of Aug 31"));
  expect(cells[1].classList.contains("reports-repeat")).toBe(true);
  // The range starts Sep 1, so the week of Aug 31 is only partly in it.
  expect(cells[0].textContent).toBe("Week of Aug 31Partial week");
  // Gross and net on the total row.
  expect(within(revenue).getAllByText("$215.50", { selector: "tfoot td" })).toHaveLength(2);

  const equipment = screen.getByRole("region", { name: "Equipment" });
  expect(within(equipment).queryByRole("link", { name: "Lathe" })).toBeNull();
  fireEvent.click(within(equipment).getByRole("button", { name: "Show 1 unused machine" }));
  expect(within(equipment).getByRole("link", { name: "Lathe" })).toBeTruthy();

  const live = screen.getByRole("region", { name: "Signed in at readers" });
  expect(within(live).getByText("Laser")).toBeTruthy();
  expect(within(live).getByText("Machine")).toBeTruthy();
  expect(within(live).getByText("2 people")).toBeTruthy();
});

test("a building reader is the front door, never the machine that shares its number", () => {
  const live = [
    { kind: "building", resourceId: 1, activeReaderLeases: 3 },
    { kind: "room", resourceId: 1, activeReaderLeases: 1 },
  ];
  const rooms = [{ id: 1, name: "Wood shop", capacity: 8, distinctVisitors: 1, recordedCheckIns: 1 }];
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report({ live, rooms }), report({ from: "2026-08-02", to: "2026-08-31" }));
  const list = screen.getByRole("region", { name: "Signed in at readers" });
  expect(within(list).queryByText("Laser")).toBeNull();
  expect(within(list).queryByText("Machine")).toBeNull();
  expect(within(list).getByText("Front door")).toBeTruthy();
  expect(within(list).getByText("Building")).toBeTruthy();
  expect(within(list).getByText("3 people")).toBeTruthy();
  expect(within(list).getByText("Wood shop")).toBeTruthy();
});

test("the machine share column says it measures the whole period, not a share of bookings", () => {
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report(), report({ from: "2026-08-02", to: "2026-08-31" }));
  const equipment = screen.getByRole("region", { name: "Equipment" });
  expect(within(equipment).queryByText(/of all hours booked/)).toBeNull();
  expect(within(equipment).getByRole("columnheader", { name: "Share of the period booked" })).toBeTruthy();
  expect(within(equipment).getByRole("tooltip", { hidden: true }).textContent).toMatch(/every hour in the dates you picked, including hours when we're closed/);
});

test("the update time is read on the facility's clock, matching the zone named beside it", () => {
  // Kathmandu and Kolkata read 1:45 and 1:30, so at least one differs from wherever the tests run.
  const generatedAt = "2026-09-30T20:00:00Z";
  const clock = (timeZone?: string) => new Date(generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });
  const facility = ["Asia/Kathmandu", "Asia/Kolkata"].find((zone) => clock(zone) !== clock())!;
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report({ timeZone: facility, generatedAt }), report({ from: "2026-08-02", to: "2026-08-31" }));
  expect(screen.getByText(/^Updated /).textContent).toBe(`Updated ${clock(facility)} ${zoneName(facility)}`);
});

test("a hand-edited link with impossible dates falls back to this month", () => {
  mount("/admin/reports?range=custom&from=2026-01-01&to=2026-09-30", report(), report());
  expect((screen.getByRole("combobox", { name: "Date range" }) as HTMLSelectElement).value).toBe("month");
});

test("the readers card explains what it counts behind a circled i", () => {
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report(), report({ from: "2026-08-02", to: "2026-08-31" }));
  const live = screen.getByRole("region", { name: "Signed in at readers" });
  const tip = within(live).getByRole("button", { name: "What this card counts" });
  expect(within(live).getByRole("tooltip", { hidden: true }).textContent).toMatch(/until their booking ends or we close/);
  expect(tip.getAttribute("aria-describedby")).toBe(within(live).getByRole("tooltip", { hidden: true }).id);
  fireEvent.click(tip);
  expect(tip.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(tip.getAttribute("aria-expanded")).toBe("false");
});

test("room visits agree with their number, and a room without a capacity doesn't print a blank one", () => {
  const rooms = [
    { id: 1, name: "Room A", capacity: null, distinctVisitors: 1, recordedCheckIns: 1 },
    { id: 2, name: "Room B", capacity: 12, distinctVisitors: 2, recordedCheckIns: 3 },
  ];
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report({ rooms }), report({ from: "2026-08-02", to: "2026-08-31" }));
  const list = screen.getByRole("region", { name: "Room visits" });
  expect(within(list).getByText("1 visit")).toBeTruthy();
  expect(within(list).getByText("1 person")).toBeTruthy();
  expect(within(list).getByText("3 visits")).toBeTruthy();
  expect(within(list).getByText("Holds 12")).toBeTruthy();
  expect(within(list).queryByText(/Holds\s*$/)).toBeNull();
  expect(list.textContent).not.toContain("null");
});

/** The page at `now` with /config answering `zone`; reports never arrive. */
function mountAt(now: string, zone: { timeZone: string } | "loading" | "failed") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  vi.mocked(useApi).mockImplementation(((path: string) =>
    path === "/config"
      ? { data: typeof zone === "object" ? zone : null, loading: zone === "loading", refreshing: false, error: zone === "failed" ? "Offline" : "", reload: vi.fn() }
      : { data: null, loading: true, refreshing: false, error: "", reload: vi.fn() }) as never);
  render(
    <MemoryRouter initialEntries={["/admin/reports"]}>
      <ReportsPage />
    </MemoryRouter>,
  );
}
const reportPaths = () => vi.mocked(useApi).mock.calls.map(([path]) => path).filter((path) => path?.startsWith("/admin/reports"));

test("the report waits for the facility zone before choosing today", () => {
  mountAt("2026-11-11T03:00:00Z", "loading");
  expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Date range" })).toBeNull();
  expect(reportPaths()).toEqual([]);
});

test("this month runs to the facility's today from /config, falling back to New York when it can't be read", () => {
  // 03:00 UTC on Nov 11 is still Nov 10 in New York but already Nov 11 in Auckland.
  mountAt("2026-11-11T03:00:00Z", { timeZone: "Pacific/Auckland" });
  expect(reportPaths()).toContain("/admin/reports?from=2026-11-01&to=2026-11-11&period=weekly");
  cleanup();
  vi.mocked(useApi).mockReset();
  mountAt("2026-11-11T03:00:00Z", "failed");
  expect(reportPaths()).toContain("/admin/reports?from=2026-11-01&to=2026-11-10&period=weekly");
  expect(reportPaths().filter((path) => path?.includes("to=2026-11-11"))).toEqual([]);
});

test("new dates keep the last report on screen, out of reach, while the date controls stay usable", () => {
  let stale = false;
  const current = report();
  vi.mocked(useApi).mockImplementation(((path: string) =>
    path === "/config"
      ? config
      : { data: current, loading: false, refreshing: false, stale: path.startsWith("/admin/reports?from=2026-09-01") && stale, error: "", reload: vi.fn() }) as never);
  render(
    <MemoryRouter initialEntries={["/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly"]}>
      <ReportsPage />
    </MemoryRouter>,
  );
  expect(vi.mocked(useApi).mock.calls.find(([path]) => path?.startsWith("/admin/reports"))?.[1]).toMatchObject({ retainOnChange: true });
  stale = true;
  fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
  const results = document.querySelector(".kept-results")!;
  expect(results.hasAttribute("inert")).toBe(true);
  expect(results.textContent).toContain("Revenue");
  expect(screen.getByRole("status").textContent).toBe("Updating…");
  expect(results.contains(screen.getByRole("combobox", { name: "Date range" }))).toBe(false);
  expect((screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement).disabled).toBe(true);
});

test("the grouping switch is one Tab stop and arrow keys move it", () => {
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report(), report({ from: "2026-08-02", to: "2026-08-31" }));
  const radios = within(screen.getByRole("radiogroup", { name: "Group results by" })).getAllByRole("radio");
  expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  radios[1].focus();
  fireEvent.keyDown(radios[1], { key: "ArrowLeft" });
  expect(document.activeElement).toBe(radios[0]);
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  expect(vi.mocked(useApi).mock.calls.map(([url]) => String(url))).toContain("/admin/reports?from=2026-09-01&to=2026-09-30&period=daily");
});

test("period names stay on one line; long names in the other tables are free to wrap", () => {
  mount("/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly", report(), report({ from: "2026-08-02", to: "2026-08-31" }));
  const revenue = screen.getByRole("region", { name: "Revenue" });
  const periods = within(revenue).getAllByText((_, el) => el?.tagName === "TD" && el.textContent!.startsWith("Week of Aug 31"));
  expect(periods.every((cell) => cell.classList.contains("reports-nowrap"))).toBe(true);
  const machine = within(screen.getByRole("region", { name: "Equipment" })).getByRole("link", { name: "Laser" }).closest("td")!;
  expect(machine.classList.contains("reports-nowrap")).toBe(false);
});

test("a busiest-times machine that drops out of the data clears its filter instead of claiming no bookings", () => {
  const slot = (id: number, name: string, hour: number) => ({ id, name, weekday: 2, hour, bookedHours: "2" });
  let current = report({ patterns: [slot(1, "Laser", 10), slot(2, "Lathe", 14)] });
  vi.mocked(useApi).mockImplementation(((url: string) =>
    url === "/config" ? config : { data: current, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() }) as never);
  // A fresh element each time, so a rerender reaches the page as a refresh would.
  const page = () => (
    <MemoryRouter initialEntries={["/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly"]}>
      <ReportsPage />
    </MemoryRouter>
  );
  const { rerender } = render(page());
  const equipment = () => screen.getByRole("region", { name: "Equipment" });
  fireEvent.change(within(equipment()).getByRole("combobox", { name: "Machine" }), { target: { value: "2" } });
  expect(within(equipment()).getByText("Tue 2pm")).toBeTruthy();

  // The next refresh no longer has the lathe's booking: the laser's hours show, not "No bookings".
  current = report({ patterns: [slot(1, "Laser", 10)] });
  rerender(page());
  expect(within(equipment()).queryByText("No bookings in this period.")).toBeNull();
  expect(within(equipment()).getByText("Tue 10am")).toBeTruthy();
  expect(within(equipment()).queryByRole("combobox", { name: "Machine" })).toBeNull();

  // The lathe coming back later doesn't silently bring the old filter with it.
  current = report({ patterns: [slot(1, "Laser", 10), slot(2, "Lathe", 14)] });
  rerender(page());
  expect((within(equipment()).getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("");
});

test("a busiest-times filter stays visible while it is on, even with one machine left", () => {
  const slot = (id: number, name: string) => ({ id, name, weekday: 2, hour: 10, bookedHours: "2" });
  let current = report({ patterns: [slot(1, "Laser"), slot(2, "Lathe")] });
  vi.mocked(useApi).mockImplementation(((url: string) =>
    url === "/config" ? config : { data: current, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() }) as never);
  // A fresh element each time, so a rerender reaches the page as a refresh would.
  const page = () => (
    <MemoryRouter initialEntries={["/admin/reports?range=custom&from=2026-09-01&to=2026-09-30&group=weekly"]}>
      <ReportsPage />
    </MemoryRouter>
  );
  const { rerender } = render(page());
  const equipment = () => screen.getByRole("region", { name: "Equipment" });
  fireEvent.change(within(equipment()).getByRole("combobox", { name: "Machine" }), { target: { value: "1" } });
  current = report({ patterns: [slot(1, "Laser")] });
  rerender(page());
  const select = within(equipment()).getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  expect(select.value).toBe("1");

  // Clearing it goes back to every machine, and with only one left the select steps aside.
  fireEvent.change(select, { target: { value: "" } });
  expect(within(equipment()).queryByRole("combobox", { name: "Machine" })).toBeNull();
  expect(within(equipment()).queryByText("No bookings in this period.")).toBeNull();
  expect(within(equipment()).getByText("Tue 10am")).toBeTruthy();
});
