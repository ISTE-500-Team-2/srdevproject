// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AccessReader, ReaderHealthBoard, ReaderHealthDetail, ReaderHealthSummary } from "../../lib/nfc";
import { ReaderManager } from "./ReaderManager";
import { daySummary, pathParts } from "./ReaderHealthParts";
import { activityLine, duration } from "./readerHealthText";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api }));
import { ApiError } from "../../lib/api";

const NOW = Date.parse("2026-11-18T20:35:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const setupReader = (id: string, name: string): AccessReader => ({
  id, name, kind: "building", resourceId: 1, resourceName: "Main building", enabled: true, online: true,
  lastSeenAt: minutesAgo(0), revision: 1,
});
const day = (segments: ReaderHealthSummary["day"]["segments"], dropouts = 0, downMinutes = 0) => ({ segments, dropouts, downMinutes });
const healthy = (change: Partial<ReaderHealthSummary["health"]> = {}) => ({
  reachable: true, ready: true, doorState: "locked" as const, rssi: -70, address: "129.21.41.118",
  firmware: "1.8.0-classic-pi", uptimeMs: 1_920_000, lastContactMs: 120, ...change,
});
const front: ReaderHealthSummary = {
  id: "front", name: "Front door", status: "working", since: null, health: healthy({ rssi: -78 }),
  lastReport: minutesAgo(0), lastSeenAt: minutesAgo(0),
  lastTap: { at: minutesAgo(4), allowed: false, reason: "CARD_REVOKED" },
  day: day([{ state: "ok", start: minutesAgo(1440), end: minutesAgo(0) }]),
};
const shop: ReaderHealthSummary = {
  id: "shop", name: "Wood shop", status: "unreachable", since: minutesAgo(21),
  health: { reachable: false, ready: null, doorState: null, rssi: null, address: null, firmware: null, uptimeMs: null, lastContactMs: 1_260_000 },
  lastReport: minutesAgo(0), lastSeenAt: minutesAgo(0), lastTap: { at: minutesAgo(43), allowed: true, reason: "ELIGIBLE" },
  day: day(
    [
      { state: "ok", start: minutesAgo(1440), end: minutesAgo(80) },
      { state: "degraded", start: minutesAgo(80), end: minutesAgo(21) },
      { state: "down", start: minutesAgo(21), end: minutesAgo(0) },
    ],
    2,
    24,
  ),
};
const board: ReaderHealthBoard = {
  generatedAt: minutesAgo(0),
  readers: [front, shop],
  gateway: { lastHeartbeatAt: minutesAgo(0), reporting: 2, reachable: 1, total: 2 },
};
const shopDetail: ReaderHealthDetail = {
  ...shop,
  signal: Array.from({ length: 96 }, (_, index) => ({
    at: new Date(NOW - (95 - index) * 15 * 60_000).toISOString(),
    rssi: index >= 94 ? null : index >= 89 ? -71 - (index - 89) * 3 : -70,
  })),
  activity: [
    { type: "unreachable", at: minutesAgo(21), detail: {} },
    { type: "tap", at: minutesAgo(43), detail: { allowed: true, reason: "ELIGIBLE", last4: "4F1A" } },
    { type: "weak_signal", at: minutesAgo(75), detail: { rssi: -84 } },
  ],
  lastKnown: { at: minutesAgo(21), ready: true, rssi: -84, address: "129.21.40.212", firmware: "1.7.1-c3-checkin" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  api.mockImplementation((path: string) => {
    if (path === "/admin/access/resources") return Promise.resolve([]);
    if (path === "/admin/access/reader-setup") return Promise.resolve({ devices: [], jobs: [], gateways: [] });
    if (path === "/admin/access/reader-health") return Promise.resolve(board);
    if (path === "/admin/access/reader-health/shop") return Promise.resolve(shopDetail);
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const mount = (
  search = "?view=readers",
  { configured = true, readers = [setupReader("front", "Front door"), setupReader("shop", "Wood shop")], reload = () => undefined } = {},
) =>
  render(
    <MemoryRouter initialEntries={[`/admin/access${search}`]}>
      <ReaderManager setup={{ configured, timeZone: "America/New_York", readers }} reload={reload} />
    </MemoryRouter>,
  );

test("the overview lists problems first and needs no refresh button", async () => {
  mount();
  const attention = await screen.findByRole("region", { name: "Needs attention" });
  expect(within(attention).getByRole("link").textContent).toContain("Wood shop: Can't reach the gateway");
  expect(within(attention).getByRole("link").textContent).toContain("Since 3:14 PM");
  expect(within(attention).getByRole("link").textContent).toContain("2 dropouts · 24 min today");
  expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/^Live/);
  const row = screen.getByRole("link", { name: "Front door: Working" });
  expect(row.getAttribute("href")).toBe("/admin/access?view=readers&reader=front");
  expect(row.textContent).toContain("Denied: card revoked");
  expect(row.textContent).toContain("Fair");
  expect(screen.getByRole("link", { name: "Wood shop: Unreachable" }).textContent).toContain("Lost");
  expect(screen.getByText(/1 of 2 readers reachable/)).toBeTruthy();
  expect(screen.getByRole("img", { name: /Reader to gateway: broken/ })).toBeTruthy();
});

test("an unreachable reader's page says what is known and what to check", async () => {
  mount("?view=readers&reader=shop");
  const diagnosis = await screen.findByRole("region", { name: "Can't reach the gateway" });
  const text = diagnosis.textContent ?? "";
  expect(text).toContain("Members can't badge in.");
  expect(text).toContain("Last check-in 3:14 PM");
  expect(text).toContain("Wi-Fi fell from -71 to -83 dBm in the hour before");
  expect(text).toContain("Gateway retrying");
  expect(text).toContain("Yellow blinking:");
  expect(screen.getByText("as of 3:14 PM")).toBeTruthy();
  expect(screen.getByText("129.21.40.212")).toBeTruthy();
  expect(screen.getByText("Stopped answering the gateway")).toBeTruthy();
  expect(screen.getByText("Card ending 4F1A")).toBeTruthy();
  expect(screen.getByRole("img", { name: /Wi-Fi signal over the last 24 hours/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage reader" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Identify|Restart|Test/ })).toBeNull();
});

test("summaries stay short", () => {
  expect(daySummary(day([], 0, 0))).toBe("No dropouts");
  expect(daySummary(day([], 1, 3))).toBe("1 dropout · 3 min");
  expect(duration(27 * 60_000)).toBe("27 min");
  expect(duration(125 * 60_000)).toBe("2 h 5 min");
  expect(activityLine({ type: "reachable", at: minutesAgo(0), detail: { outageSeconds: 1620 } })).toEqual({
    title: "Back online",
    detail: "Out 27 min",
  });
  expect(pathParts("not_reporting")).toEqual({ reader: "unknown", readerLink: "unknown", gateway: "bad", cloudLink: "bad" });
  expect(pathParts("unreachable").readerLink).toBe("bad");
});

test("without live health the readers stay listed and manageable", async () => {
  api.mockImplementation((path: string) => {
    if (path === "/admin/access/resources") return Promise.resolve([]);
    if (path === "/admin/access/reader-setup") return Promise.resolve({ devices: [], jobs: [], gateways: [] });
    return Promise.reject(new ApiError(500, "server_error", "Reader health unavailable"));
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Manage Front door" }));
  expect(screen.getByRole("dialog", { name: "Manage reader" })).toBeTruthy();
});

test("an unconfigured setup lists its readers without asking for health", async () => {
  mount("?view=readers", { configured: false });
  expect(await screen.findByRole("button", { name: "Manage Wood shop" })).toBeTruthy();
  expect(api.mock.calls.some(([path]) => path === "/admin/access/reader-health")).toBe(false);
});

test("a reader the board knows but the list lacks reloads the list once", async () => {
  const reload = vi.fn();
  mount("?view=readers", { readers: [setupReader("front", "Front door")], reload });
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  await screen.findByRole("link", { name: "Front door: Working" });
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a reader still in setup says so on its page", async () => {
  mount("?view=readers&reader=shop", { readers: [setupReader("front", "Front door")] });
  expect(await screen.findByText("This reader is still being set up.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Readers" })).toBeTruthy();
});
