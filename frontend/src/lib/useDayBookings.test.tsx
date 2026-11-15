// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Reservation } from "./contracts";
import { useBookingsAround } from "./useDayBookings";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api, ApiError: class extends Error {}, errorMessage: (error: Error) => error.message }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const refresh = { retainOnReload: true, refreshInterval: 0 };
const booking = (id: number, startTime: string, extra: Partial<Reservation> = {}): Reservation => ({
  id,
  userId: 1,
  equipmentId: 3,
  equipmentName: "Laser",
  startTime,
  endTime: new Date(Date.parse(startTime) + 3_600_000).toISOString(),
  location: "Shop",
  status: "confirmed",
  revision: 1,
  ...extra,
});

let latest: ReturnType<typeof useBookingsAround>;
function Probe({ day }: { day: string }) {
  latest = useBookingsAround(day, refresh);
  return latest.loaders;
}

test("reads the day before through two days after, following each day's pages, and merges them in time order", async () => {
  const pages: Record<string, unknown> = {
    "/admin/reservations?date=2026-11-11": { items: [booking(1, "2026-11-11T23:00:00Z")], nextOffset: null },
    "/admin/reservations?date=2026-11-12": { items: [booking(2, "2026-11-12T15:00:00Z"), booking(1, "2026-11-11T23:00:00Z")], nextOffset: 50 },
    "/admin/reservations?date=2026-11-12&offset=50": { items: [booking(3, "2026-11-12T13:00:00Z", { status: "cancelled" })], nextOffset: null },
    "/admin/reservations?date=2026-11-13": { items: [booking(4, "2026-11-13T10:00:00Z", { resourceType: "room" })], nextOffset: null },
    "/admin/reservations?date=2026-11-14": { items: [booking(5, "2026-11-14T01:00:00Z")], nextOffset: null },
  };
  api.mockImplementation((path: string) => Promise.resolve(pages[path]));
  render(<Probe day="2026-11-12" />);
  expect(latest.loading).toBe(true);
  await act(async () => {});
  expect(api.mock.calls.map(([path]) => path).sort()).toEqual(Object.keys(pages).sort());
  expect(latest.loading).toBe(false);
  expect(latest.failure).toBeUndefined();
  // Cancelled and room bookings are not equipment bookings; one seen on two days is listed once.
  expect(latest.bookings.map((b) => b.id)).toEqual([1, 2, 5]);
});

test("a failed day is reported with its retry and stops counting as loading", async () => {
  let fail = true;
  api.mockImplementation((path: string) =>
    path === "/admin/reservations?date=2026-11-13" && fail
      ? Promise.reject(new Error("Bookings unavailable"))
      : Promise.resolve({ items: [], nextOffset: null }),
  );
  render(<Probe day="2026-11-12" />);
  await act(async () => {});
  expect(latest.failure?.error).toBe("Bookings unavailable");
  expect(latest.loading).toBe(false);
  fail = false;
  await act(async () => latest.failure?.reload());
  expect(latest.failure).toBeUndefined();
  expect(latest.loading).toBe(false);
});
