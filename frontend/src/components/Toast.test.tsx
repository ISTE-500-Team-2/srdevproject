// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toast } from "./Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the live region is on the page before a message arrives, so the message is announced as a change", () => {
  const close = vi.fn();
  const view = render(<Toast message={null} onClose={close} />);
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("");
  view.rerender(<Toast message="Reservation confirmed for Laser Cutter." onClose={close} />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("Reservation confirmed for Laser Cutter.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(close).toHaveBeenCalledOnce();
  view.rerender(<Toast message={null} onClose={close} />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("");
});

test("a message that arrives with the page is added after its live region", () => {
  vi.useFakeTimers();
  render(<Toast message="Welcome back." onClose={() => {}} />);
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("");
  act(() => vi.advanceTimersByTime(100));
  expect(region.textContent).toBe("Welcome back.");
});
