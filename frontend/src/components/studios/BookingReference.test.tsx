// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { BookingReference } from "./BookingReference";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([false, true])("the reference stays readable without a code input (reduced motion: %s)", (reducedMotion) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(<BookingReference id={42} />);
  const reference = screen.getByRole("group", { name: "Booking reference 000042" });
  const value = within(reference).getByText("000042");
  expect(value.closest("[inert]")).toBeNull();
  expect(reference.querySelector("input")).toBeNull();

  act(() => vi.advanceTimersByTime(5000));
  expect(within(reference).getByText("000042")).toBe(value);
});

test("the displayed reference updates for a new booking without truncating longer numbers", () => {
  const { rerender } = render(<BookingReference id={42} />);
  rerender(<BookingReference id={123} />);
  expect(screen.getByText("000123")).toBeTruthy();
  expect(screen.queryByText("000042")).toBeNull();

  rerender(<BookingReference id={1234567} />);
  const reference = screen.getByRole("group", { name: "Booking reference 1234567" });
  expect(within(reference).getByText("1234567")).toBeTruthy();
  expect(screen.queryByText("000123")).toBeNull();
});
