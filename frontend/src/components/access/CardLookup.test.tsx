// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardAssignment, ReaderSetup } from "../../lib/nfc";
import { dateTime } from "../../lib/display";
import { AssignmentResults, CardLookup } from "./CardLookup";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", () => ({
  api,
  errorMessage: (e: Error) => e.message,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

const setup: ReaderSetup = {
  configured: true,
  timeZone: "Asia/Tokyo",
  readers: [
    {
      id: "front",
      name: "Front door",
      kind: "building",
      resourceId: 1,
      resourceName: "Collaboratory",
      enabled: true,
      online: true,
      lastSeenAt: null,
      revision: 1,
    },
  ],
};
const owner: CardAssignment = {
  id: 9,
  userId: 14,
  memberName: "Casey Demo",
  label: "Blue fob",
  active: true,
  assignedAt: "2026-10-01T20:30:00Z",
};
const mount = (tapId?: number) =>
  render(
    <MemoryRouter>
      <CardLookup setup={setup} tapId={tapId} />
    </MemoryRouter>,
  );
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });

test("a captured lookup keeps its answer after the scan window and offers another scan", async () => {
  vi.useFakeTimers();
  const scan = {
    id: "0f0e0d0c-0b0a-4000-8000-000000000001",
    readerId: "front",
    userId: null,
    purpose: "lookup",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/admin/access/enrollments" && options?.method === "POST")
      return Promise.resolve({ ...scan, status: "waiting" });
    if (path === `/admin/access/enrollments/${scan.id}`)
      return Promise.resolve({
        ...scan,
        status: "captured",
        last4: "1A2B",
        assignments: [owner],
      });
    if (path.endsWith("/cancel")) return Promise.resolve({ cancelled: false });
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  await flush();
  await flush();
  expect(screen.getByText(/Currently assigned/)).toBeTruthy();
  // The lookup is finished: no countdown or cancel for a scan that is already done.
  expect(screen.queryByText(/seconds remaining/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel scan" })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(130_000);
  });
  expect(screen.getByText(/Currently assigned/)).toBeTruthy();
  expect(screen.queryByText(/This scan expired/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Scan another card" }));
  await flush();
  expect(screen.getByRole("button", { name: "Start card scan" })).toBeTruthy();
  expect(screen.queryByText(/Currently assigned/)).toBeNull();
});

test("assignment times use the facility's time zone, matching the tap times beside them", () => {
  const { container } = render(
    <MemoryRouter>
      <AssignmentResults assignments={[owner]} timeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );
  expect(container.textContent).toContain(dateTime(owner.assignedAt, "Asia/Tokyo"));
  expect(dateTime(owner.assignedAt, "Asia/Tokyo")).not.toBe(
    dateTime(owner.assignedAt, "America/Los_Angeles"),
  );
});

test("a typed lookup after opening from a tap says it is looking up the typed card", async () => {
  vi.useFakeTimers();
  let finishTyped!: (value: CardAssignment[]) => void;
  api.mockImplementation((path: string, options?: { body?: Record<string, unknown> }) => {
    if (path === "/admin/access/cards/lookup" && options?.body?.eventId === 7)
      return Promise.resolve([owner]);
    if (path === "/admin/access/cards/lookup" && options?.body?.uid)
      return new Promise((resolve) => {
        finishTyped = resolve;
      });
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
  mount(7);
  expect(screen.getByText("Looking up the card from that tap…")).toBeTruthy();
  await flush();
  expect(screen.getByText("Card from the selected tap:")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("NFC card ID"), {
    target: { value: "04A1B2C3" },
  });
  fireEvent.submit(screen.getByLabelText("NFC card ID").closest("form")!);
  await flush();
  expect(screen.getByRole("button", { name: "Looking up card…" })).toBeTruthy();
  expect(screen.queryByText("Looking up the card from that tap…")).toBeNull();
  await act(async () => finishTyped([]));
  expect(screen.getByText("No member has been assigned this card.")).toBeTruthy();
  expect(screen.queryByText("Card from the selected tap:")).toBeNull();
});
