// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StartTimePicker } from "./StartTimePicker";

afterEach(cleanup);
const value = () => (document.querySelector('input[name="start"]') as HTMLInputElement).value;
const times = () =>
  Array.from((screen.getByLabelText("Start time") as HTMLSelectElement).options).map((o) => o.textContent);

test("today only offers times that haven't started yet", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 14, 10)} />);
  expect(screen.getByRole("radio", { name: /Tuesday, October 27/ }).getAttribute("aria-checked")).toBe("true");
  expect(times()[0]).toMatch(/2:30/);
  expect(value()).toBe("2026-10-27T14:30");
});

test("another day offers the whole day and keeps the chosen time", () => {
  render(<StartTimePicker name="start" hours={2} now={new Date(2026, 9, 27, 14, 10)} />);
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: String(18 * 60) } });
  fireEvent.click(screen.getByRole("radio", { name: /Thursday, October 29/ }));
  expect(times()[0]).toMatch(/12:00/);
  expect(value()).toBe("2026-10-29T18:00");
  expect(screen.getByText(/Thu, Oct 29/).textContent).toMatch(/6:00.*8:00/);
});

test("late at night the first day offered is tomorrow", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 23, 45)} />);
  expect(screen.getAllByRole("radio")[0]!.textContent).toMatch(/Tomorrow/);
  expect(value()).toBe("2026-10-28T00:00");
});

test("a booking that runs past midnight says so", () => {
  render(<StartTimePicker name="start" hours={3} now={new Date(2026, 9, 27, 21, 50)} />);
  expect(screen.getByText(/the next day/)).toBeTruthy();
});
