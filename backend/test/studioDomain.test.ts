import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/domain.js';
import { studioLeaseWindow } from '../src/studioDomain.js';

test('studio terms use whole calendar months and clamp month-end dates', () => {
    const now = new Date('2030-01-01T12:00:00Z');
    assert.deepEqual(
        studioLeaseWindow('2030-01-31', 1, 'UTC', now),
        { startDate: '2030-01-31', endDate: '2030-02-28', months: 1 },
    );
    assert.deepEqual(
        studioLeaseWindow('2030-01-31', '2', 'UTC', now),
        { startDate: '2030-01-31', endDate: '2030-03-31', months: 2 },
    );
    assert.deepEqual(
        studioLeaseWindow('2032-01-31', 1, 'UTC', now),
        { startDate: '2032-01-31', endDate: '2032-02-29', months: 1 },
    );
});

test('studio lease dates and terms reject past, malformed, and non-whole-month input', () => {
    const now = new Date('2030-01-15T12:00:00Z');
    for (const [start, months] of [
        ['2030-01-15', 1],
        ['2030-02-30', 1],
        ['02/01/2030', 1],
        ['2030-02-01', 0],
        ['2030-02-01', -1],
        ['2030-02-01', 1.5],
        ['2030-02-01', '1month'],
        ['2030-02-01', Number.MAX_SAFE_INTEGER + 1],
    ] as const)
        assert.throws(() => studioLeaseWindow(start, months, 'UTC', now), AppError);
});

test('studio start date uses the configured local calendar date', () => {
    const now = new Date('2030-01-02T02:00:00Z');
    assert.throws(
        () => studioLeaseWindow('2030-01-01', 1, 'America/Los_Angeles', now),
        AppError,
    );
    assert.equal(
        studioLeaseWindow('2030-01-02', 1, 'America/Los_Angeles', now).startDate,
        '2030-01-02',
    );
});
