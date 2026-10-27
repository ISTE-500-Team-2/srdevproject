// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StaffStudios } from "./StaffStudios";

const { api, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { roles: ["staff"] } as unknown },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../lib/api", () => ({ api, errorMessage: (error: Error) => error.message }));

beforeEach(() => {
  api.mockImplementation((path: string) =>
    Promise.resolve(path === "/studios" ? { studios: [] } : []),
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const calls = (path: string) => api.mock.calls.filter(([p]) => p === path).length;

test("new holds show up when staff come back to the tab", async () => {
  render(<StaffStudios />);
  await waitFor(() => expect(calls("/studio-management/rentals")).toBe(1));
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(calls("/studio-management/rentals")).toBe(2));
  expect(screen.getByText("Nothing waiting.")).toBeTruthy();
});

test("rates and terms are for admins only", async () => {
  render(<StaffStudios />);
  await screen.findByText("Nothing waiting.");
  expect(screen.queryByRole("heading", { name: "Rates and terms" })).toBeNull();
});
