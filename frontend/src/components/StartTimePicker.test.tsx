// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StartTimePicker } from "./StartTimePicker";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const value = () => (document.querySelector('input[name="start"]') as HTMLInputElement).value;
const picker = () => screen.getByLabelText("Start time") as HTMLSelectElement;

test.each([
  [19, 16, "2026-10-27T19:30"],
  [19, 30, "2026-10-27T20:00"],
  [19, 59, "2026-10-27T20:00"],
  [23, 45, "2026-10-28T00:00"],
])("rounds %i:%i up to the next future half-hour", (hour, minute, expected) => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, Number(hour), Number(minute))} />);
  expect(value()).toBe(expected);
  expect(picker().value).toBe(String(expected).slice(11));
  expect([...picker().options].every(option => /:(00|30)$/.test(option.value))).toBe(true);
});

test("supports distant dates and preserves a selected half-hour across day changes", () => {
  render(<StartTimePicker name="start" hours={2} now={new Date(2026, 9, 27, 14, 10)} />);
  fireEvent.change(screen.getByLabelText("Booking date"), { target: { value: "2027-02-18" } });
  fireEvent.change(picker(), { target: { value: "18:30" } });
  expect(value()).toBe("2027-02-18T18:30");
  expect(picker().options).toHaveLength(48);
  expect(screen.getByText(/Thu, Feb 18/).textContent).toMatch(/6:30.*8:30/);
  fireEvent.click(screen.getByRole("radio", { name: /Thursday, October 29/ }));
  expect(value()).toBe("2026-10-29T18:30");
});

test("returning to today advances an earlier selected time", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 19, 16)} />);
  fireEvent.click(screen.getAllByRole("radio")[1]!);
  fireEvent.change(picker(), { target: { value: "09:00" } });
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  expect(value()).toBe("2026-10-27T19:30");
  expect(picker().options[0]!.value).toBe("19:30");
});

test("an open picker advances stale selections when the clock passes a slot", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 27, 19, 29));
  render(<StartTimePicker name="start" hours={1} />);
  expect(value()).toBe("2026-10-27T19:30");
  act(() => vi.advanceTimersByTime(90000));
  expect(value()).toBe("2026-10-27T20:00");
  expect(picker().options[0]!.value).toBe("20:00");
});

test("a booking that runs past midnight says so", () => {
  render(<StartTimePicker name="start" hours={3} now={new Date(2026, 9, 27, 21, 50)} />);
  expect(screen.getByText(/the next day/)).toBeTruthy();
});
