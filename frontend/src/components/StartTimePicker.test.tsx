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

test("paid booking lead time rounds up to a slot at least 30 minutes away", () => {
  render(<StartTimePicker name="start" hours={1} minLeadMinutes={30} now={new Date(2026, 9, 27, 19, 16)} />);
  expect(value()).toBe("2026-10-27T20:00");
  expect(picker().options[0]!.value).toBe("20:00");
  expect(screen.getByText(/Book at least 30 minutes ahead/)).toBeTruthy();
});

test("paid booking minimum advances the picker date when the lead crosses midnight", () => {
  render(<StartTimePicker name="start" hours={1} minLeadMinutes={30} now={new Date(2026, 9, 27, 23, 20)} />);
  expect(value()).toBe("2026-10-28T00:00");
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


test("hides other members' occupied times, the cooldown and starts that cannot fit the duration", () => {
 const occupied=[{startTime:new Date(2026,9,27,17).toISOString(),endTime:new Date(2026,9,27,18).toISOString()}];
 const {rerender}=render(<StartTimePicker calendar name="start" hours={1} now={new Date(2026,9,27,12)} occupied={occupied}/>);
 let options=[...picker().options].map(o=>o.value);
 expect(options).not.toContain('17:00'); expect(options).not.toContain('16:00');
 expect(options).not.toContain('18:00'); expect(options).toContain('15:30'); expect(options).toContain('18:30');
 fireEvent.change(picker(),{target:{value:'15:30'}});
 rerender(<StartTimePicker calendar name="start" hours={2} now={new Date(2026,9,27,12)} occupied={occupied}/>);
 expect([...picker().options].map(o=>o.value)).not.toContain('15:30');
 expect(value()).not.toBe('2026-10-27T15:30');
});

test("fully occupied days have an unavailable marker and no submittable time; cancellation restores times", () => {
 const now=new Date(2026,9,27,12);
 const {rerender}=render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[{startTime:new Date(2026,9,27).toISOString(),endTime:new Date(2026,9,28).toISOString()}]}/>);
 const day=screen.getByRole('button',{name:'Tue, Oct 27, 2026: unavailable'}) as HTMLButtonElement;
 expect(day.disabled).toBe(true); expect(day.querySelector('.studio-cal__unavailable-mark')).toBeTruthy();
 expect(value()).toBe(''); expect(picker().options[0]!.text).toBe('No available times');
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[]}/>);
 expect(value()).not.toBe(''); expect((screen.getByRole('button',{name:'Tue, Oct 27, 2026'}) as HTMLButtonElement).disabled).toBe(false);
});

test("a large future schedule keeps the same cooldown boundaries after an availability refresh", () => {
 const now = new Date(2026, 9, 27, 12);
 const future = Array.from({length: 500}, (_, i) => ({
  startTime: new Date(2027, 0, 1 + i, 14).toISOString(),
  endTime: new Date(2027, 0, 1 + i, 15).toISOString(),
 }));
 const {rerender} = render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={future}/>);
 const options = () => [...picker().options].map(option => option.value);
 expect(options()).toContain('16:00');
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[...future, {
  startTime: new Date(2026, 9, 27, 17).toISOString(),
  endTime: new Date(2026, 9, 27, 18).toISOString(),
 }]}/>);
 expect(options()).not.toContain('16:00');
 expect(options()).not.toContain('18:00');
 expect(options()).toContain('15:30');
 expect(options()).toContain('18:30');
});
