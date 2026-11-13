import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reminderDates } from '../src/notifications/scheduler.js';
import { reminderTimingCases } from './notification-timing-cases.js';

test('reminders are queued at local 09:00 eight days out, before the seven-day deadline', () => {
  for (const c of reminderTimingCases) {
    const expiry = new Date(c.expiresAt);
    const { dueAt, deadlineAt } = reminderDates(expiry, c.timeZone);
    assert.equal(dueAt.toISOString(), c.dueAt, c.name);
    assert.equal(deadlineAt.getTime(), expiry.getTime() - 7 * 86_400_000, c.name);
    assert.ok(dueAt.getTime() <= deadlineAt.getTime() - 3_600_000, c.name);
  }
});
