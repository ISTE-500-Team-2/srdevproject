// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StaffReservations } from "./StaffReservations";
import { api, ApiError } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Reservation } from "../lib/contracts";

vi.mock("../lib/useApi", () => ({ useApi: vi.fn() }));
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../components/MemberSelect", () => ({ MemberSelect: ({ label = "Member" }: { label?: string }) => <input aria-label={label} /> }));

const reservation: Reservation = { id: 17, userId: 12, equipmentId: 3, equipmentName: "Laser cutter", resourceType: "equipment", startTime: "2026-11-03T15:00:00Z", endTime: "2026-11-03T17:00:00Z", location: "Workshop", status: "confirmed", revision: 2, memberName: "Jordan Member" };
const reload = vi.fn();
const scrollIntoView = vi.fn();
beforeEach(() => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path?.startsWith("/admin/reservations") ? { items: [reservation], nextOffset: null } : [], loading: false, refreshing: false, error: "", reload }));
  vi.mocked(api).mockResolvedValue({});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const mount = () => render(<MemoryRouter><StaffReservations /></MemoryRouter>);

test("equipment detail links open reservations filtered to the selected machine", () => {
  render(<MemoryRouter initialEntries={["/admin/reservations?equipmentId=3"]}><StaffReservations /></MemoryRouter>);
  expect(vi.mocked(useApi).mock.calls.some(([path]) => path === "/admin/reservations?offset=0&equipmentId=3")).toBe(true);
});

test("Modify reveals and focuses the updated editor every time it is selected", async () => {
  mount();
  const modify = screen.getByRole("button", { name: "Modify" });
  fireEvent.click(modify);
  const heading = screen.getByRole("heading", { name: "Modify reservation" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  modify.focus();
  fireEvent.click(modify);
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
});

test("Cancel names the reservation and requires confirmation; keeping it performs no write", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel this reservation?" });
  expect(dialog.textContent).toContain("Laser cutter · reservation #17");
  expect(dialog.textContent).toContain("Jordan Member");
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep reservation" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api).toHaveBeenCalledExactlyOnceWith("/admin/reservations/17/cancel", { method: "POST" });
  expect(reload).toHaveBeenCalledOnce();
});

test("failed cancellation stays in the confirmation dialog and can be retried", async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError(409, "STALE_RECORD", "Please retry."));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Please retry.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api).toHaveBeenCalledTimes(2);
});
