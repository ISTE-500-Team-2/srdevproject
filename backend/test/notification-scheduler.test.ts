import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reminderDates} from '../src/notifications/scheduler.js';
import {validTimeZone} from '../src/notifications/store.js';
test('reminders use local 09:00 across DST with seven-day deadline headroom',()=>{
  for(const [expiry,expected] of [['2026-03-12T20:00:00Z','2026-03-04T14:00:00.000Z'],['2026-11-05T20:00:00Z','2026-10-28T13:00:00.000Z']]) {
    const result=reminderDates(new Date(expiry!), 'America/New_York');
    assert.equal(result.dueAt.toISOString(),expected);
    assert.equal(result.deadlineAt.getTime(),new Date(expiry!).getTime()-7*86400000);
    assert.ok(result.dueAt<result.deadlineAt);
  }
});
test('user timezone determines calendar date; invalid zones rejected',()=>{
  assert.equal(reminderDates(new Date('2026-09-17T00:00:00Z'),'Asia/Tokyo').dueAt.toISOString(),'2026-09-09T00:00:00.000Z');
  assert.equal(validTimeZone('Invalid/Zone'),false);
  assert.equal(validTimeZone('Europe/Zagreb'),true);
  assert.throws(()=>reminderDates(new Date(),'Not/AZone'));
});
