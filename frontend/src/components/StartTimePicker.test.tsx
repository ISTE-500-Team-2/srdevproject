// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StartTimePicker } from "./StartTimePicker";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const value = () => (document.querySelector('input[name="start"]') as HTMLInputElement).value;
const picker = () => screen.getByLabelText("Start time") as HTMLSelectElement;

// The earliest start is at least two minutes away, so it is still in the future when the form is sent.
test.each([
  [19, 16, "2026-10-27T19:30"],
  [19, 28, "2026-10-27T19:30"],
  [19, 30, "2026-10-27T20:00"],
  [19, 59, "2026-10-27T20:30"],
  [23, 45, "2026-10-28T00:00"],
])("rounds %i:%i up to the next half-hour with time to spare", (hour, minute, expected) => {
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

test.each([
  // Seconds count: 10:00 is less than 30 minutes after 9:30:20, so the server would refuse it.
  [new Date(2026, 9, 27, 9, 30, 20), "10:30"],
  [new Date(2026, 9, 27, 9, 0, 30), "10:00"],
  [new Date(2026, 9, 27, 9, 28), "10:00"],
])("the earliest paid start leaves the 30-minute lead plus a margin (%s)", (now, expected) => {
  render(<StartTimePicker name="start" hours={1} minLeadMinutes={30} now={now} />);
  expect(picker().options[0]!.value).toBe(expected);
  expect(value()).toBe(`2026-10-27T${expected}`);
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

test("returning to today moves the suggested time on, but never a time the member chose", () => {
  render(<StartTimePicker name="start" hours={1} now={new Date(2026, 9, 27, 19, 16)} />);
  fireEvent.click(screen.getAllByRole("radio")[1]!);
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  expect(value()).toBe("2026-10-27T19:30");
  expect(picker().options[0]!.value).toBe("19:30");
  fireEvent.click(screen.getAllByRole("radio")[1]!);
  fireEvent.change(picker(), { target: { value: "09:00" } });
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  // 9 AM has passed today: nothing is chosen until the member picks again.
  expect(value()).toBe("");
  expect(picker().value).toBe("");
  expect(screen.getByRole("alert").textContent).toMatch(/9:00\sAM can no longer be booked/);
  fireEvent.change(picker(), { target: { value: "20:00" } });
  expect(value()).toBe("2026-10-27T20:00");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an open picker advances a suggested time when the clock passes a slot", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 27, 19, 27));
  render(<StartTimePicker name="start" hours={1} />);
  expect(value()).toBe("2026-10-27T19:30");
  act(() => vi.advanceTimersByTime(90000));
  expect(value()).toBe("2026-10-27T20:00");
  expect(picker().options[0]!.value).toBe("20:00");
});

test("a chosen time the clock passes is not moved to a later one", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 27, 19, 20));
  render(<StartTimePicker name="start" hours={1} />);
  fireEvent.change(picker(), { target: { value: "19:30" } });
  act(() => vi.advanceTimersByTime(9 * 60000));
  expect(value()).toBe("");
  expect(screen.getByRole("alert").textContent).toMatch(/7:30\sPM can no longer be booked/);
});

test("a chosen time left open past midnight keeps its day and asks for another day", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 27, 23, 0));
  render(<StartTimePicker name="start" hours={1} />);
  fireEvent.change(picker(), { target: { value: "23:30" } });
  expect(value()).toBe("2026-10-27T23:30");
  act(() => vi.advanceTimersByTime(70 * 60000));
  // Not quietly moved to 11:30 PM tomorrow: the member is asked for a new day.
  expect(value()).toBe("");
  expect((screen.getByLabelText("Booking date") as HTMLInputElement).value).toBe("2026-10-27");
  expect(screen.getByRole("alert").textContent).toMatch(/11:30\sPM on Tue, Oct 27 can no longer be booked\. Choose another day and start time\./);
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  expect(value()).toBe("2026-10-28T23:30");
  expect(screen.queryByRole("alert")).toBeNull();
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
 // The longer booking no longer fits at 3:30: the member is told, and no other time is put in its place.
 expect(value()).toBe('');
 expect(picker().value).toBe('');
 expect(screen.getByRole('alert').textContent).toMatch(/3:30\sPM isn’t available for 2 hours/);
 expect(screen.getByText('Choose a date and start time.')).toBeTruthy();
});

test("a chosen time taken by someone else, or missing on another day, is not swapped for midnight", () => {
 const now=new Date(2026,9,27,12);
 const {rerender}=render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[]}/>);
 fireEvent.click(screen.getByRole('button',{name:'Fri, Oct 30, 2026'}));
 fireEvent.change(picker(),{target:{value:'15:00'}});
 expect(value()).toBe('2026-10-30T15:00');
 // An availability refresh shows another member booked 3 PM.
 const taken=[{startTime:new Date(2026,9,30,15).toISOString(),endTime:new Date(2026,9,30,16).toISOString()}];
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={taken}/>);
 expect(value()).toBe('');
 expect(screen.getByRole('alert').textContent).toMatch(/3:00\sPM isn’t available for 1 hour on this day/);
 expect(picker().getAttribute('aria-invalid')).toBe('true');
 // Another day where 3 PM is free brings the chosen time back.
 fireEvent.click(screen.getByRole('button',{name:'Sat, Oct 31, 2026'}));
 expect(value()).toBe('2026-10-31T15:00');
 expect(screen.queryByRole('alert')).toBeNull();
});

test("a suggested time that is taken moves to the next free start, not back to midnight", () => {
 const now=new Date(2026,9,27,12);
 const taken=[{startTime:new Date(2026,9,30,12).toISOString(),endTime:new Date(2026,9,30,14).toISOString()}];
 render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={taken}/>);
 fireEvent.click(screen.getByRole('button',{name:'Fri, Oct 30, 2026'}));
 // The suggestion was 12:30; the booking and its 15-minute gap run to 2:15 PM.
 expect(value()).toBe('2026-10-30T14:30');
 expect(screen.queryByRole('alert')).toBeNull();
});

test("a suggested time that a longer booking or an availability refresh pushes on is announced beside the field", () => {
 const now=new Date(2026,9,27,12);
 const busy=[{startTime:new Date(2026,9,27,14).toISOString(),endTime:new Date(2026,9,27,15).toISOString()}];
 const {rerender}=render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={busy}/>);
 expect(value()).toBe('2026-10-27T12:30');
 expect(screen.queryByRole('status')).toBeNull();
 rerender(<StartTimePicker calendar name="start" hours={2} now={now} occupied={busy}/>);
 // 12:30–2:30 overlaps the 2 PM booking and its 15-minute gap; 3:30 is the next start that fits.
 expect(value()).toBe('2026-10-27T15:30');
 const note=screen.getByRole('status');
 expect(note.textContent).toMatch(/12:30\sPM isn’t available for 2 hours on this day, so the start time moved to 3:30\sPM\./);
 expect(picker().getAttribute('aria-describedby')).toBe(note.id);
 // Shortening it again keeps 3:30 instead of jumping back, and the note goes.
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={busy}/>);
 expect(value()).toBe('2026-10-27T15:30');
 expect(screen.queryByRole('status')).toBeNull();
 // An availability refresh shows another member took 3:30.
 const taken=[...busy,{startTime:new Date(2026,9,27,15,30).toISOString(),endTime:new Date(2026,9,27,16,30).toISOString()}];
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={taken}/>);
 expect(value()).toBe('2026-10-27T17:00');
 expect(screen.getByRole('status').textContent).toMatch(/3:30\sPM isn’t available for 1 hour on this day, so the start time moved to 5:00\sPM\./);
 expect(screen.queryByRole('alert')).toBeNull();
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

test("a chosen time on a machine that goes out of service is not blamed on the time", () => {
 const now=new Date(2026,9,27,12);
 const {rerender}=render(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[]}/>);
 fireEvent.change(picker(),{target:{value:'15:00'}});
 expect(value()).toBe('2026-10-27T15:00');
 // A sibling machine in maintenance, or a catalog refresh, marks the machine out of service.
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[]} unavailable/>);
 expect(value()).toBe('');
 expect(picker().options[0]!.text).toBe('No available times');
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.queryByRole('status')).toBeNull();
 expect(picker().getAttribute('aria-invalid')).toBeNull();
 // Back on a machine in service, the chosen time returns.
 rerender(<StartTimePicker calendar name="start" hours={1} now={now} occupied={[]}/>);
 expect(value()).toBe('2026-10-27T15:00');
 expect(screen.queryByRole('alert')).toBeNull();
});
