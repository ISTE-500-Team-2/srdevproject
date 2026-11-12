import { expect, test } from 'vitest';
import { addCalendarDays } from './calendarDate';
import { shiftDay } from './analytics';
import { addDays as studioAddDays } from './studioDisplay';
import { addDays as todayAddDays, previousDay } from './today';

test('adds calendar days across month, year, leap-day and DST boundaries', () => {
  expect(addCalendarDays('2026-01-31', 1)).toBe('2026-02-01');
  expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
  expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
  expect(addCalendarDays('2026-11-01', -1)).toBe('2026-10-31');
  expect(addCalendarDays('2026-11-10', -29)).toBe('2026-10-12');
  expect(addCalendarDays('2026-11-10', 0)).toBe('2026-11-10');
});

test('the older helper names are the same function', () => {
  expect(shiftDay).toBe(addCalendarDays);
  expect(studioAddDays).toBe(addCalendarDays);
  expect(todayAddDays).toBe(addCalendarDays);
  expect(previousDay('2026-03-01')).toBe('2026-02-28');
});

test('an invalid date still throws, as before', () => {
  expect(() => addCalendarDays('not a date', 1)).toThrow(RangeError);
});
