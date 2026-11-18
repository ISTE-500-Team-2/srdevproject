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

test("a confirmation is a polite status; a problem is an alert in the warning style", () => {
  const view = render(<Toast message={null} onClose={() => undefined} />);
  const region = screen.getByRole("status");
  view.rerender(<Toast message="Refunded $50.00." onClose={() => undefined} />);
  expect(region.querySelector(".toast")?.className).toBe("toast");
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<Toast message="Stripe didn't complete the refund." tone="problem" onClose={() => undefined} />);
  // The polite region empties, and the problem is announced as an alert instead.
  expect(region.textContent).toBe("");
  const alert = screen.getByRole("alert");
  expect(alert.className).toBe("toast toast--problem");
  expect(alert.textContent).toBe("Stripe didn't complete the refund.");
  // Like the status region, it stays usable above an open dialog.
  expect(alert.hasAttribute("data-live-region")).toBe(true);
});
