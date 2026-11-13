/** Shared expiration-reminder timing cases. The scheduler's first queueing
 * (notification-timing.test.ts) and a member's time zone change
 * (integration/notification-reschedule.test.ts) must both produce these send times. */
export interface ReminderTimingCase { name: string; expiresAt: string; timeZone: string; dueAt: string }
export const reminderTimingCases: ReminderTimingCase[] = [
  // Expiry after spring-forward; the reminder falls before it, on standard time.
  { name: 'New York, across spring-forward', expiresAt: '2026-03-12T20:00:00.000Z', timeZone: 'America/New_York', dueAt: '2026-03-04T14:00:00.000Z' },
  // Expiry after fall-back; the reminder falls before it, on daylight time.
  { name: 'New York, across fall-back', expiresAt: '2026-11-05T20:00:00.000Z', timeZone: 'America/New_York', dueAt: '2026-10-28T13:00:00.000Z' },
  { name: 'London, across the October change', expiresAt: '2026-11-01T10:00:00.000Z', timeZone: 'Europe/London', dueAt: '2026-10-24T08:00:00.000Z' },
  // Half-hour standard offset with a half-hour DST shift.
  { name: 'Lord Howe, across the April change', expiresAt: '2026-04-10T00:00:00.000Z', timeZone: 'Australia/Lord_Howe', dueAt: '2026-04-01T22:00:00.000Z' },
  // The local calendar date differs from the UTC date of the expiry.
  { name: 'Los Angeles, local date before the UTC date', expiresAt: '2026-06-10T03:00:00.000Z', timeZone: 'America/Los_Angeles', dueAt: '2026-06-01T16:00:00.000Z' },
  { name: 'Tokyo, local date after the UTC date', expiresAt: '2026-09-16T20:00:00.000Z', timeZone: 'Asia/Tokyo', dueAt: '2026-09-09T00:00:00.000Z' },
  // An expiry at 23:59 local still uses that local day.
  { name: 'Kolkata, late on the local day', expiresAt: '2026-07-20T18:29:00.000Z', timeZone: 'Asia/Kolkata', dueAt: '2026-07-12T03:30:00.000Z' },
];
