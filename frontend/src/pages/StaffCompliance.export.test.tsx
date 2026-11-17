// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StaffCompliance } from "./StaffCompliance";
import { ApiError, apiText } from "../lib/api";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../lib/useApi", () => ({ useApi }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), apiText: vi.fn() }));
vi.mock("../components/staff/record/MemberRecord", () => ({ MemberRecord: () => null }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useApi.mockReset();
  vi.mocked(apiText).mockReset();
});

const idle = () => ({ data: null, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() });

test("the CSV download keeps its file address until the browser has had time to start saving", async () => {
  vi.useFakeTimers();
  useApi.mockImplementation(idle);
  vi.mocked(apiText).mockResolvedValue("name,status\n");
  const create = vi.fn(() => "blob:compliance");
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    // Firefox only downloads from a link that is part of the page.
    expect(this.isConnected).toBe(true);
  });
  render(<StaffCompliance />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  });
  expect(click).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(revoke).toHaveBeenCalledWith("blob:compliance");
  expect(document.querySelector("a[download]")).toBeNull();
});

test("a failed export is announced with the server's message", async () => {
  useApi.mockImplementation(idle);
  vi.mocked(apiText).mockRejectedValue(new ApiError(413, "EXPORT_TOO_LARGE", "Compliance export is limited to 10,000 rows."));
  render(<StaffCompliance />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("Compliance export is limited to 10,000 rows.");
});
