// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { StaffReservations } from "./StaffReservations";
import type { Reservation } from "../lib/contracts";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api, ApiError: class extends Error {}, errorMessage: (error: Error) => error.message }));
vi.mock("../components/MemberSelect", () => ({
  MemberSelect: ({ onChange }: { onChange?: (value: string) => void }) => (
    <button type="button" onClick={() => onChange?.("12")}>
      Pick Jordan Member
    </button>
  ),
}));

// 9:00 AM in New York on Tuesday, Nov 3, 2026.
const NOW = Date.parse("2026-11-03T14:00:00Z");
const reservation: Reservation = {
  id: 17, userId: 12, equipmentId: 3, equipmentName: "Laser cutter", resourceType: "equipment",
  startTime: "2026-11-03T15:00:00Z", endTime: "2026-11-03T17:00:00Z", location: "Makerspace",
  status: "confirmed", revision: 2, memberName: "Jordan Member", memberEmail: "jordan@example.test",
  paymentStatus: "paid", priceSnapshot: null, amountCents: 5000,
};
let booking: Reservation = reservation;
const price = { currency: "USD", hours: 1, hourlyRateCents: 2500, equipmentCents: 2500, trainingFeeCents: 0, totalCents: 2500, certificationId: null, certificationRevision: null };

beforeEach(() => {
  booking = reservation;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.mockImplementation((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === "/config") return Promise.resolve({ timeZone: "America/New_York" });
    if (path === "/equipment") return Promise.resolve([{ id: 3, name: "Laser cutter", type: "Laser", status: "available", image: "", certification: "Laser safety" }]);
    if (path.startsWith("/admin/reports?")) return Promise.resolve({ live: [] });
    if (path === "/admin/reservations?date=2026-11-03") return Promise.resolve({ items: [booking], nextOffset: null });
    if (path.startsWith("/admin/reservations?date=")) return Promise.resolve({ items: [], nextOffset: null });
    if (path.startsWith("/admin/reservations?")) return Promise.resolve({ items: [booking], nextOffset: null });
    if (path.startsWith("/equipment/3/quote")) return Promise.resolve(price);
    if (path === "/admin/reservations/17/cancel") return Promise.resolve({ ...booking, status: "cancelled" });
    if (path === "/reservations" && options?.method === "POST")
      return Promise.resolve({ ...reservation, id: 30, startTime: options.body!.startTime, endTime: options.body!.endTime, revision: 1 });
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function Location() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname + location.search}</output>;
}
const mount = (entry = "/admin/reservations") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <StaffReservations />
      <Location />
    </MemoryRouter>,
  );
const listCalls = () => api.mock.calls.map(([path]) => path as string).filter((path) => path.includes("when="));

test("a member's account link opens their upcoming reservations, and the filter can be removed", async () => {
  mount("/admin/reservations?member=12");
  expect(await screen.findByText("Jordan Member’s reservations")).toBeTruthy();
  expect(listCalls()).toContain("/admin/reservations?offset=0&when=upcoming&userId=12");
  expect(screen.getByRole("button", { name: /List/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Show all reservations" }));
  await waitFor(() => expect(screen.getByLabelText("location").textContent).toBe("/admin/reservations"));
  await waitFor(() => expect(listCalls()).toContain("/admin/reservations?offset=0&when=upcoming"));
});

test("a machine's page link opens the list filtered to that machine", async () => {
  mount("/admin/reservations?equipmentId=3");
  await waitFor(() => expect(listCalls()).toContain("/admin/reservations?offset=0&when=upcoming&equipmentId=3"));
});

test("the schedule draws the day like Today and opens a reservation beside it", async () => {
  mount();
  expect(await screen.findByRole("heading", { name: "Today, Tuesday, Nov 3" })).toBeTruthy();
  expect(await screen.findByText("1 reservation today · 0 machines in use now.")).toBeTruthy();
  const block = await screen.findByRole("button", { name: "Jordan Member, 10:00 AM–12:00 PM, booked" });
  expect(block.className).toContain("today-block--booked");
  expect(screen.getByText("Open, next at 10:00 AM")).toBeTruthy();
  fireEvent.click(block);
  const panel = screen.getByRole("complementary", { name: "Reservation" });
  expect(within(panel).getByRole("heading", { name: "Laser cutter, 10:00 AM–12:00 PM" })).toBeTruthy();
  expect(within(panel).getByText("Laser safety")).toBeTruthy();
  expect(within(panel).getByText("$50.00")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Laser cutter, 10:00 AM–12:00 PM" })));
  expect(within(panel).getByRole("link", { name: "Open member" }).getAttribute("href")).toBe("/admin/members?member=12");
});

test("cancelling asks first; keeping it writes nothing", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Jordan Member, 10:00 AM/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel…" }));
  const confirm = screen.getByRole("group", { name: "Cancel this reservation?" });
  expect(confirm.textContent).toContain("This frees Laser cutter 10:00 AM–12:00 PM for Jordan Member.");
  fireEvent.click(within(confirm).getByRole("button", { name: "Keep reservation" }));
  expect(api.mock.calls.some(([path]) => String(path).endsWith("/cancel"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel…" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(await screen.findByText("Reservation #17 cancelled.")).toBeTruthy();
  expect(api).toHaveBeenCalledWith("/admin/reservations/17/cancel", { method: "POST" });
  expect(await screen.findByRole("heading", { name: "Needs you" })).toBeTruthy();
});

test("a reservation paid online can be cancelled but not moved here", async () => {
  booking = { ...reservation, payerId: 12 };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Jordan Member, 10:00 AM/ }));
  expect(screen.getByText("Booked with online payment, so the time and machine can’t be changed here.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Change time or machine/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel…" })).toBeTruthy();
});

test("an unpaid hold is listed under Needs you with its release time", async () => {
  booking = { ...reservation, status: "pending", holdUntil: "2026-11-03T14:31:00Z" };
  mount();
  expect(await screen.findByText("Jordan Member hasn’t paid yet")).toBeTruthy();
  expect(screen.getByText(/Released at 9:31 AM if unpaid\./)).toBeTruthy();
  expect((await screen.findByRole("button", { name: "Jordan Member, 10:00 AM–12:00 PM, awaiting payment" })).className).toContain("res-block--hold");
});

test("searching shows matching reservations in the list; clearing it goes back to the schedule", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a member or machine" }), { target: { value: "jordan" } });
    expect(screen.getByRole("button", { name: /List/ }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(listCalls()).toContain("/admin/reservations?offset=0&when=upcoming&search=jordan");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a member or machine" }), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /Schedule/ }).getAttribute("aria-pressed")).toBe("true");
  } finally {
    vi.useRealTimers();
  }
});

test("clicking open time books that machine at that time, with taken times crossed out", async () => {
  mount();
  await screen.findByRole("button", { name: /Jordan Member, 10:00 AM/ });
  const track = screen.getByRole("group", { name: "Laser cutter, Today, Tuesday, Nov 3" });
  // The track spans 9 AM to 9 PM.
  track.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, height: 36, right: 1200, bottom: 36, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(track, { clientX: 410 });
  expect(await screen.findByRole("heading", { name: "Book equipment" })).toBeTruthy();
  expect((screen.getByRole("combobox", { name: /Equipment/ }) as HTMLSelectElement).value).toBe("3");
  expect((await screen.findByRole("button", { name: "1:00 PM" })).getAttribute("aria-pressed")).toBe("true");
  expect((await screen.findByRole("button", { name: "10:00 AM, taken" }) as HTMLButtonElement).disabled).toBe(true);
  // A new reservation needs a 15-minute gap after the one ending at noon.
  expect((screen.getByRole("button", { name: "12:00 PM, taken" }) as HTMLButtonElement).disabled).toBe(true);
  const book = screen.getByRole("button", { name: "Book" }) as HTMLButtonElement;
  expect(book.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pick Jordan Member" }));
  await waitFor(() => expect(book.disabled).toBe(false));
  fireEvent.click(book);
  expect(await screen.findByText("Booked Laser cutter for Jordan Member, 1:00–2:00 PM.")).toBeTruthy();
  const [, options] = api.mock.calls.find(([path, o]) => path === "/reservations" && o?.method === "POST")!;
  expect(options.body).toMatchObject({ userId: 12, equipmentId: 3, roomId: null, startTime: "2026-11-03T18:00:00.000Z", endTime: "2026-11-03T19:00:00.000Z", expectedPrice: price });
});

test("clicking other open time while booking starts a fresh form at that time", async () => {
  mount();
  await screen.findByRole("button", { name: /Jordan Member, 10:00 AM/ });
  const track = screen.getByRole("group", { name: "Laser cutter, Today, Tuesday, Nov 3" });
  track.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, height: 36, right: 1200, bottom: 36, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(track, { clientX: 410 });
  expect((await screen.findByRole("button", { name: "1:00 PM" })).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "2 hours" }));
  fireEvent.click(track, { clientX: 610 });
  await waitFor(() => expect(screen.getByRole("button", { name: "3:00 PM" }).getAttribute("aria-pressed")).toBe("true"));
  expect(screen.getByRole("button", { name: "1:00 PM" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "1 hour" }).getAttribute("aria-pressed")).toBe("true");
});

test("the editor counts the next day's bookings, so a late start can't run into one after midnight", async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation((path: string, options?: unknown) =>
    path === "/admin/reservations?date=2026-11-04"
      ? Promise.resolve({ items: [{ ...reservation, id: 40, startTime: "2026-11-04T05:00:00Z", endTime: "2026-11-04T06:00:00Z" }], nextOffset: null })
      : original(path, options),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "New reservation" }));
  const tenPm = (await screen.findByRole("button", { name: "10:00 PM" })) as HTMLButtonElement;
  await waitFor(() => expect(tenPm.disabled).toBe(false));
  fireEvent.click(tenPm);
  // 10–11 PM leaves the 15-minute gap before the 12 AM booking; two hours would not.
  await waitFor(() => expect((screen.getByRole("button", { name: "2 hours" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("button", { name: "1 hour" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "11:00 PM, taken" }) as HTMLButtonElement).disabled).toBe(true);
});

test("when a day's times can't be loaded, the editor says so and can retry", async () => {
  const original = api.getMockImplementation()!;
  let down = true;
  api.mockImplementation((path: string, options?: unknown) =>
    path === "/admin/reservations?date=2026-11-04" && down ? Promise.reject(new Error("Service unavailable.")) : original(path, options),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "New reservation" }));
  const alert = await screen.findByText(/Times for this day could not be loaded\. Service unavailable\./);
  expect((screen.getByRole("button", { name: "10:00 PM" }) as HTMLButtonElement).disabled).toBe(true);
  down = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "10:00 PM" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});

test("a save that finishes after staff opened something else doesn't replace it", async () => {
  const original = api.getMockImplementation()!;
  let finish: (value: Reservation) => void = () => {};
  api.mockImplementation((path: string, options?: { method?: string }) =>
    path === "/reservations" && options?.method === "POST"
      ? new Promise<Reservation>((resolve) => { finish = resolve; })
      : original(path, options),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "New reservation" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick Jordan Member" }));
  const onePm = (await screen.findByRole("button", { name: "1:00 PM" })) as HTMLButtonElement;
  await waitFor(() => expect(onePm.disabled).toBe(false));
  fireEvent.click(onePm);
  const book = screen.getByRole("button", { name: "Book" }) as HTMLButtonElement;
  await waitFor(() => expect(book.disabled).toBe(false));
  fireEvent.click(book);
  // Staff opens the existing reservation while the booking is still saving.
  fireEvent.click(screen.getByRole("button", { name: /Jordan Member, 10:00 AM/ }));
  expect(screen.getByRole("heading", { name: "Laser cutter, 10:00 AM–12:00 PM" })).toBeTruthy();
  await act(async () => finish({ ...reservation, id: 31, startTime: "2026-11-03T18:00:00Z", endTime: "2026-11-03T19:00:00Z" }));
  expect(await screen.findByText("Booked Laser cutter for Jordan Member, 1:00–2:00 PM.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Laser cutter, 10:00 AM–12:00 PM" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Laser cutter, 1:00–2:00 PM" })).toBeNull();
});
