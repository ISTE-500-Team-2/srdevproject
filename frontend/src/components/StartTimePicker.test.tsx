// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StartTimePicker } from "./StartTimePicker";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const value = () => (document.querySelector('input[name="start"]') as HTMLInputElement).value;

test("starts in the future with minute precision", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 14, 10)} />);
  expect(value()).toBe("2026-10-27T14:11");
  expect((screen.getByLabelText("Start time") as HTMLInputElement).min).toBe("14:11");
});

test("supports dates beyond two weeks and times between half-hour slots", () => {
  render(<StartTimePicker name="start" hours={2} now={new Date(2026, 9, 27, 14, 10)} />);
  fireEvent.change(screen.getByLabelText("Booking date"), { target: { value: "2027-02-18" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "18:17" } });
  expect(value()).toBe("2027-02-18T18:17");
  expect(screen.getByText(/Thu, Feb 18/).textContent).toMatch(/6:17.*8:17/);
});

test("quick day buttons keep an exact chosen time", () => {
  render(<StartTimePicker name="start" hours={2} now={new Date(2026, 9, 27, 14, 10)} />);
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "18:17" } });
  fireEvent.click(screen.getByRole("radio", { name: /Thursday, October 29/ }));
  expect(value()).toBe("2026-10-29T18:17");
});

test("after the last available minute defaults to tomorrow", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 23, 59, 30)} />);
  expect(value()).toBe("2026-10-28T00:00");
});

test("an open picker refreshes its minimum instead of claiming stale times are valid", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 27, 14, 10));
  render(<StartTimePicker name="start" hours={1} />);
  act(() => vi.advanceTimersByTime(90000));
  expect((screen.getByLabelText("Start time") as HTMLInputElement).min).toBe("14:12");
  expect((screen.getByLabelText("Start time") as HTMLInputElement).checkValidity()).toBe(false);
});

test("a booking that runs past midnight says so", () => {
  render(<StartTimePicker name="start" hours={3} now={new Date(2026, 9, 27, 21, 50)} />);
  expect(screen.getByText(/the next day/)).toBeTruthy();
});
