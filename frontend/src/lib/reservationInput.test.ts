import { describe, expect, it } from 'vitest';
import { reservationInput } from './reservationInput';
describe('reservation input', () => {
  it('converts local input to explicit ISO times and preserves elapsed duration', () => {
    const input = reservationInput(
      4,
      '2030-06-01T14:00',
      2,
      new Date('2030-01-01').getTime(),
    );
    expect(input.equipmentId).toBe(4);
    expect(input.startTime.endsWith('Z')).toBe(true);
    expect(
      new Date(input.endTime).getTime() - new Date(input.startTime).getTime(),
    ).toBe(7_200_000);
  });
  it('rejects impossible calendar dates, past times and unsupported durations', () => {
    const now = new Date('2030-01-01').getTime();
    expect(() => reservationInput(1, '2030-02-30T14:00', 1, now)).toThrow(
      RangeError,
    );
    expect(() => reservationInput(1, '2029-06-01T14:00', 1, now)).toThrow(
      RangeError,
    );
    expect(() => reservationInput(1, '2030-06-01T14:00', 0, now)).toThrow(
      RangeError,
    );
  });
});
