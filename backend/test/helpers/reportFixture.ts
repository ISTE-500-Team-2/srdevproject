import type { ReportData } from '../../src/reports/types.js';

const cohort = (eligible: number, onTime: number) => ({
  eligible, on_time: onTime, accepted: onTime, failed: 1, uncertain: 0, pending: 2,
  delivered: onTime, delivery_on_time: onTime, delivery_failed: 0,
  onTimePercent: eligible ? (100 * onTime) / eligible : null,
  deliveryOnTimePercent: eligible ? (100 * onTime) / eligible : null,
});

/**
 * A report covering the serializer edge cases: spreadsheet-formula prefixes,
 * quotes, nulls, records with different keys, Date values, non-ASCII text,
 * PDF string escapes, lines longer than 95 characters and several PDF pages.
 * Date values render through Date#toString, so compare output with TZ=UTC.
 */
export function reportFixture(): ReportData {
  return {
    from: '2030-01-01',
    to: '2030-01-31',
    timeZone: 'America/New_York',
    period: 'weekly',
    generatedAt: '2030-02-01T12:00:00.000Z',
    revenue: [
      { period: '2029-12-30', category: '=SUM(A1:A9)', method: 'card', receipts: 2, gross: '100.00', refunds: '0', net: '100.00' },
      { period: '2030-01-06', category: 'Studio rental', method: '+cash', receipts: 1, gross: '-5.00', refunds: '5.00', net: '-10.00' },
      { period: '2030-01-13', category: 'He said "hi" (twice) \\ back', method: '@check', receipts: 1, gross: '12.50', refunds: '0', net: '12.50' },
      { period: '2030-01-20', category: '\tTabbed', method: '\rcarriage', receipts: 1, gross: '1.00', refunds: '0', net: '1.00' },
    ],
    equipment: [
      { id: 1, name: 'Laser – cutter ✓', bookedHours: 3.5, reservations: 2, windowHours: '744', bookedUtilizationPercent: 0.47043010752688175 },
    ],
    patterns: Array.from({ length: 40 }, (_, i) => ({ id: 1 + (i % 3), name: `Machine ${1 + (i % 3)}`, weekday: 1 + (i % 7), hour: i % 24, bookedHours: (i / 4).toString() })),
    classes: [
      { id: 7, title: 'Intro, (safety) and more', capacity: 15, status: 'scheduled', startsAt: new Date(Date.UTC(2030, 0, 2, 15)), room: 'Room A', enrolled: 3, attended: 1, filledPercent: '20.0000000000000000' },
    ],
    rooms: [
      { id: 1, name: 'Room A', capacity: null, recordedCheckIns: 0, distinctVisitors: 0 },
      { id: 2, name: 'Room B', capacity: 12, recordedCheckIns: 4, distinctVisitors: 3 },
    ],
    active: { activeUsers: 3, approvedCheckIns: 4 },
    compliance: {
      activeAccounts: 10, restrictedAccounts: 1, expiredTraining: 0, trainingWithoutExpiry: 2,
      activeMemberships: 5, signaturesWithoutCopy: 0, machinesWithoutTraining: ['Drill', 'Saw'],
    },
    live: [{ kind: 'equipment', resourceId: null, activeReaderLeases: 1 }],
    usage: [{ equipmentId: 1, authorizedHours: '0.00138888888888888889' }],
    visitsByDay: [{ day: '2030-01-01', visits: 1, people: 1 }],
    checkedInToday: [{ userId: 4, name: 'Not exported', location: 'Room A', at: new Date(Date.UTC(2030, 0, 31)), method: 'portal' }],
    checkedInTodayCount: 1,
    memberships: [
      { period: '2029-12-30', newMembers: 1, activeMembers: 4, expiringMembers: 0, cancelledMembers: 0 },
      { period: '2030-01-06', newMembers: 0, activeMembers: 4, expiringMembers: 1, cancelledMembers: 1, extra: 'only on this row' },
    ],
    notifications: {
      ...cohort(3, 2),
      metric: 'provider acceptance by deadline; not inbox delivery',
      deliveryMetric: 'provider delivered callbacks by deadline; not verified inbox placement',
      cohortWindow: 'deadline date; only elapsed eligible deadlines enter percentage denominators',
      cohorts: { expirationCompliance: cohort(3, 2), membershipExpiration: cohort(0, 0), other: cohort(1, 1) },
    },
    notes: [
      'A short note.',
      'A note long enough to wrap across more than one line of the PDF, because the PDF serializer wraps every line at ninety-five characters exactly.',
      'Café notes keep non-ASCII in CSV — and blank it in the PDF.',
    ],
  };
}
