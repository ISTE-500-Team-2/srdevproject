// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StartTimePicker } from "./StartTimePicker";

// Daylight-saving behaviour depends on the process time zone; pin one that has it.
process.env.TZ = "America/New_York";

afterEach(cleanup);
const picker = () => screen.getByLabelText("Start time") as HTMLSelectElement;
const chooseDate = (value: string) => fireEvent.change(screen.getByLabelText("Booking date"), { target: { value } });

test("the time zone is pinned for these tests", () => {
  expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240);
  expect(new Date(2026, 11, 1).getTimezoneOffset()).toBe(300);
});

test("spring-forward day offers no start times the clock skips", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2027, 2, 13, 12)} />);
  chooseDate("2027-03-14");
  const values = [...picker().options].map((option) => option.value);
  expect(values).not.toContain("02:00");
  expect(values).not.toContain("02:30");
  expect(values).toContain("01:30");
  expect(values).toContain("03:00");
  expect(values).toHaveLength(46);
});

test("the summary ends the booking after the elapsed hours across a clock change", () => {
  render(<StartTimePicker name="start" hours={12} now={new Date(2026, 9, 30, 12)} />);
  chooseDate("2026-10-31");
  fireEvent.change(picker(), { target: { value: "22:00" } });
  // 12 hours after 10 PM EDT is 9 AM EST, when the booking really ends (see reservationInput).
  expect(screen.getByText(/Sat, Oct 31/).textContent).toMatch(/10:00\sPM – 9:00\sAM the next day/);
});
