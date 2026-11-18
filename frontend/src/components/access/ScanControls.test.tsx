// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ScanControls } from "./ScanControls";
import { useCardScan } from "../../lib/useCardScan";
import type { AccessReader, CardScan } from "../../lib/nfc";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  api,
}));

const reader = (over: Partial<AccessReader> = {}): AccessReader => ({
  id: "front",
  name: "Front door",
  kind: "building",
  resourceId: 1,
  resourceName: "Main building",
  enabled: true,
  online: true,
  lastSeenAt: null,
  revision: 1,
  ...over,
});
function Harness({ readers }: { readers: AccessReader[] }) {
  const scan = useCardScan("lookup");
  return (
    <MemoryRouter>
      <ScanControls
        setup={{ configured: true, timeZone: "America/New_York", readers }}
        scan={scan}
      />
    </MemoryRouter>
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

test("the reader picker warns that a scan pauses the door or machine it controls", () => {
  render(
    <Harness
      readers={[
        reader(),
        reader({
          id: "laser",
          name: "Laser reader",
          kind: "equipment",
          resourceId: 4,
          resourceName: "Laser cutter",
        }),
      ]}
    />,
  );
  expect(
    screen.getByText(/Scanning here pauses Main building/).textContent,
  ).toContain("the door won’t open for anyone until the scan ends");
  fireEvent.change(screen.getByLabelText("Reader for this scan"), {
    target: { value: "laser" },
  });
  expect(
    screen.getByText(/Scanning here pauses Laser cutter/).textContent,
  ).toContain("the machine won’t turn on for anyone until the scan ends");
});

test("a computer whose clock runs fast still gets the scan's full time", async () => {
  // This browser's clock is 3 minutes ahead of the server's, so by its own clock the
  // scan's expiresAt has already passed even though the server gives it two minutes.
  const serverNow = Date.now() - 180_000;
  const waiting: CardScan = {
    id: "scan",
    readerId: "front",
    userId: null,
    purpose: "lookup",
    status: "waiting",
    expiresAt: new Date(serverNow + 120_000).toISOString(),
    expiresInMs: 120_000,
  };
  api.mockImplementation(async () => waiting);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<Harness readers={[reader()]} />);
  fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  expect(await screen.findByText(/Tap one NFC card at Front door/)).toBeTruthy();
  // Past the first countdown ticks and status polls.
  await act(() => vi.advanceTimersByTimeAsync(1200));
  expect(screen.queryByText(/This scan expired/)).toBeNull();
  const remaining = Number(
    screen.getByText(/seconds remaining/).textContent!.split(" ")[0],
  );
  expect(remaining).toBeGreaterThanOrEqual(115);
  expect(remaining).toBeLessThanOrEqual(120);
}, 15_000);

test("the server's own expired status still ends the scan", async () => {
  const scan = (status: CardScan["status"]): CardScan => ({
    id: "scan",
    readerId: "front",
    userId: null,
    purpose: "lookup",
    status,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    expiresInMs: 120_000,
  });
  api.mockImplementation(async (path: string, options?: { method?: string }) =>
    options?.method === "POST" ? scan("waiting") : scan("expired"),
  );
  render(<Harness readers={[reader()]} />);
  fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  expect(
    await screen.findByText("This scan expired. Start a new scan."),
  ).toBeTruthy();
});
