// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AccessReadiness } from "./AccessReadiness";
import { api, ApiError } from "../../lib/api";
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
test("a known setup failure is fetched once and retried only on request", async () => {
  vi.useFakeTimers();
  vi.mocked(api).mockRejectedValue(
    new ApiError(
      503,
      "DEVICES_NOT_CONFIGURED",
      "No access readers are configured.",
    ),
  );
  await act(async () => {
    render(<AccessReadiness userId={12} />);
  });
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("No access readers");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh access check" }),
    );
  });
  expect(api).toHaveBeenCalledTimes(2);
});
test("successful previews expire without silently polling locking transactions", async () => {
  vi.useFakeTimers();
  vi.mocked(api).mockResolvedValue({
    userId: 12,
    readerId: "front",
    readers: [],
    allowed: true,
    reason: "ELIGIBLE",
    cardAssigned: true,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });
  await act(async () => {
    render(<AccessReadiness userId={12} />);
  });
  expect(screen.getByText("Ready to use")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Not verified")).toBeTruthy();
});
