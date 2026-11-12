// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
import { useApi } from '../lib/useApi';
vi.mock('../lib/useApi', () => ({ useApi: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
// The links to Payments, Members and Classes need a router.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
const report = (over: Record<string, unknown> = {}) => ({ from: '2026-10-12', to: '2026-11-10', period: 'weekly', timeZone: 'America/New_York', generatedAt: '2026-11-10T16:00:00Z', revenue: [], classes: [], active: { approvedCheckIns: 0, activeUsers: 0 }, visitsByDay: [], checkedInToday: [], checkedInTodayCount: 0, compliance: { activeMemberships: 0 }, notes: [], ...over });
const state = (data: unknown) => ({ data, loading: false, refreshing: false, error: '', reload: vi.fn() }) as never;
/** The requests the page makes, as "path?from&to&period" keys, in any order. */
const requestKey = (url: string) => {
  const { pathname, searchParams } = new URL(url, 'http://test.invalid');
  return `${pathname}?from=${searchParams.get('from')}&to=${searchParams.get('to')}&period=${searchParams.get('period')}`;
};
const requested = () => vi.mocked(useApi).mock.calls.map(([url]) => requestKey(String(url)));
/** Every report requested while `action` runs, independent of hook-call order or count. */
function requestsDuring(action: () => void) {
  vi.mocked(useApi).mockClear();
  action();
  return requested();
}
/**
 * Pins today to Tue Nov 10, 2026 (New York), so the default 30-day range is
 * Oct 12 to Nov 10 by week and its comparison is the 30 days before, by day.
 * Each fixture is served only for its own URL; any other request fails the test.
 */
function serve(current: Record<string, unknown>, previous: Record<string, unknown> = current) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T16:00:00Z'));
  const fixtures = new Map<string, unknown>([
    ['/admin/reports?from=2026-10-12&to=2026-11-10&period=weekly', current],
    ['/admin/reports?from=2026-09-12&to=2026-10-11&period=daily', { ...previous, from: '2026-09-12', to: '2026-10-11', period: 'daily' }],
  ]);
  vi.mocked(useApi).mockImplementation((url) => {
    const key = requestKey(String(url));
    if (!fixtures.has(key)) throw new Error(`Unexpected request: ${key}`);
    return state(fixtures.get(key));
  });
}

test.each(['From', 'Through'])('historical dates can be entered starting with %s without requesting an invalid range', (first) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T16:00:00Z'));
  vi.mocked(useApi).mockReturnValue({ data: null, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
  const from = screen.getByLabelText('From') as HTMLInputElement;
  const through = screen.getByLabelText('Through') as HTMLInputElement;
  const halfway = requestsDuring(() => fireEvent.change(first === 'From' ? from : through, { target: { value: first === 'From' ? '2026-01-01' : '2026-01-31' } }));
  expect(screen.getByRole('alert').textContent).toMatch(/93 days/);
  // The half-entered range is never requested; the last valid one stays applied.
  expect(halfway).toContainEqual(expect.stringContaining('from=2026-09-28&to=2026-10-27&'));
  expect(halfway.filter((key) => key.includes('2026-01-'))).toEqual([]);
  const complete = requestsDuring(() => fireEvent.change(first === 'From' ? through : from, { target: { value: first === 'From' ? '2026-01-31' : '2026-01-01' } }));
  expect([from.value, through.value]).toEqual(['2026-01-01', '2026-01-31']);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(complete).toContainEqual(expect.stringContaining('from=2026-01-01&to=2026-01-31&'));
  // Clearing a date is allowed; the last valid range remains applied.
  const cleared = requestsDuring(() => fireEvent.change(from, { target: { value: '' } }));
  expect(from.value).toBe('');
  expect(cleared).toContainEqual(expect.stringContaining('from=2026-01-01&to=2026-01-31&'));
  expect(cleared.filter((key) => key.includes('from=&') || key.includes('from=null'))).toEqual([]);
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'month' } });
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
  expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-01');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the right-now line counts every check-in today, not the capped recent list', () => {
  const checkedInToday = Array.from({ length: 50 }, (_, i) => ({ userId: i, name: `Visitor ${i}`, location: 'Studio', at: '2026-10-27T15:00:00Z', method: 'portal' }));
  vi.mocked(useApi).mockReturnValue({ data: { from: '2026-10-01', to: '2026-10-27', period: 'daily', timeZone: 'America/New_York', generatedAt: '2026-10-27T16:00:00Z', revenue: [], classes: [], active: { approvedCheckIns: 75, activeUsers: 75 }, visitsByDay: [], checkedInToday, checkedInTodayCount: 75, compliance: { activeMemberships: 0 }, notes: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  expect(screen.getByText(/checked in today/).closest('p')!.textContent).toContain('75 checked in today');
  // Names belong to the Today page; this page only counts them.
  expect(screen.queryByText('Visitor 0')).toBeNull();
});

test('daily visit values including zero-count days are readable without hover', () => {
  vi.mocked(useApi).mockReturnValue({ data: { from: '2026-10-25', to: '2026-10-27', period: 'daily', timeZone: 'America/New_York', generatedAt: '2026-10-27T16:00:00Z', revenue: [], classes: [], active: { approvedCheckIns: 9, activeUsers: 9 }, visitsByDay: [{ day: '2026-10-25', visits: 2 }, { day: '2026-10-26', visits: 0 }, { day: '2026-10-27', visits: 7 }], checkedInToday: [], compliance: { activeMemberships: 0 }, notes: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  fireEvent.click(screen.getByText('Show daily visit counts'));
  const table = screen.getByRole('table', { name: 'Visits per day' });
  expect(within(table).getAllByRole('row').map(row => row.textContent)).toEqual(['DateVisits', '2026-10-252', '2026-10-260', '2026-10-277']);
});

test('FR-073: the dashboard headline shows total active memberships', () => {
  vi.mocked(useApi).mockReturnValue({ data: { from: '2026-10-25', to: '2026-10-27', period: 'daily', timeZone: 'America/New_York', generatedAt: '2026-10-27T16:00:00Z', revenue: [], classes: [], visitsByDay: [], checkedInToday: [], checkedInTodayCount: 0, active: { activeUsers: 0, approvedCheckIns: 0 }, compliance: { activeMemberships: 42 }, notes: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() } as never);
  render(<AnalyticsDashboardPage />);
  expect(screen.getByText(/checked in today/).closest('p')!.textContent).toContain('42 active memberships');
});

test('the revenue axis tops out just above the tallest week instead of doubling it', () => {
  serve(report({ revenue: [{ period: '2026-10-26', category: 'membership', method: 'card', receipts: 6, gross: '1018.00', refunds: '95.00', net: '923.00' }] }));
  render(<AnalyticsDashboardPage />);
  const axis = screen.getByRole('region', { name: 'Revenue chart' }).querySelector('.period-bars__axis')!;
  // Bars show net ($923), so the axis clears net, not gross.
  expect(axis.textContent).toBe('$1,000$750$500$250$0');
});

test('each bar is compared with exactly its own days, 30 days earlier', () => {
  const sale = (period: string, net: string) => ({ period, category: 'Monthly', method: 'card', receipts: 1, gross: net, refunds: '0', net });
  serve(
    report({ revenue: [sale('2026-10-26', '923.00'), sale('2026-11-09', '20.00')] }),
    // Sep 26 to Oct 2 lines up with the week of Oct 26; Oct 10 and 11 with the two days of Nov 9 in range.
    report({ revenue: [sale('2026-09-25', '999.00'), sale('2026-09-26', '300.00'), sale('2026-10-02', '110.00'), sale('2026-10-10', '40.00')] }),
  );
  render(<AnalyticsDashboardPage />);
  expect(screen.getByLabelText('Week of Oct 26: $923 net, 1 receipt; 30 days earlier: $410')).toBeTruthy();
  expect(screen.getByLabelText('Week of Nov 9 (partial: 2 of 7 days): $20 net, 1 receipt; 30 days earlier: $40')).toBeTruthy();
  const card = screen.getByText('Revenue by week').closest('article')!;
  expect(card.querySelector('.analytics-legend')!.textContent).toBe('Net30 days earlier');
});

test('"This week" compares with the same weekdays last week, not the weekend before it', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T16:00:00Z'));
  vi.mocked(useApi).mockReturnValue(state(null));
  render(<AnalyticsDashboardPage />);
  const week = requestsDuring(() => fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'week' } }));
  expect(week).toContainEqual(expect.stringContaining('from=2026-11-09&to=2026-11-10&'));
  expect(week).toContainEqual('/admin/reports?from=2026-11-02&to=2026-11-03&period=daily');
  expect(week.filter((key) => key.includes('from=2026-11-07'))).toEqual([]);
  const month = requestsDuring(() => fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'month' } }));
  expect(month).toContainEqual(expect.stringContaining('from=2026-11-01&to=2026-11-10&'));
  expect(month).toContainEqual('/admin/reports?from=2026-10-01&to=2026-10-10&period=daily');
});

test('a chart is one Tab stop; arrow keys move between its bars', () => {
  serve(report({ revenue: [{ period: '2026-10-26', category: 'membership', method: 'card', receipts: 6, gross: '1018.00', refunds: '95.00', net: '923.00' }] }));
  render(<AnalyticsDashboardPage />);
  const bars = within(screen.getByRole('region', { name: 'Revenue chart' })).getAllByRole('option');
  // The latest period is the way in.
  expect(bars.map((bar) => bar.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
  bars[4].focus();
  fireEvent.keyDown(bars[4], { key: 'ArrowLeft' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(document.activeElement!.getAttribute('aria-label')).toMatch(/^Week of Oct 26/);
  expect(bars.map((bar) => bar.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(document.activeElement).toBe(bars[0]);
});

test('bar details show under the chart on focus, without covering the bars', () => {
  serve(report({ revenue: [{ period: '2026-10-26', category: 'membership', method: 'card', receipts: 6, gross: '1018.00', refunds: '95.00', net: '923.00' }] }));
  render(<AnalyticsDashboardPage />);
  const readout = screen.getByRole('region', { name: 'Revenue chart' }).nextElementSibling!;
  expect(readout.textContent).toMatch(/tap a bar/);
  fireEvent.focus(screen.getByLabelText('Week of Oct 26: $923 net, 6 receipts, $95 refunded; 30 days earlier: $0'));
  expect(readout.textContent).toBe('Week of Oct 26$923 net30 days earlier: $0$95 refunded6 receipts');
});

test('a period only partly inside the range is marked, so it does not read as a slow week', () => {
  // Mon Oct 12 to Tue Nov 10: the last week has two days in range.
  serve(report({ revenue: [{ period: '2026-11-09', category: 'membership', method: 'card', receipts: 1, gross: '20.00', refunds: '0', net: '20.00' }] }));
  render(<AnalyticsDashboardPage />);
  const bar = screen.getByLabelText(/^Week of Nov 9 \(partial: 2 of 7 days\): \$20 net, 1 receipt/);
  expect(bar.className).toContain('is-partial');
  expect(screen.getByLabelText(/^Week of Oct 12: \$0 net, 0 receipts/).className).not.toContain('is-partial');
  fireEvent.focus(bar);
  expect(screen.getByRole('region', { name: 'Revenue chart' }).nextElementSibling!.textContent).toContain('Partial: 2 of 7 days in range');
});

test('revenue by source ranks plans by net and folds the long tail', () => {
  const sale = (category: string, net: string) => ({ period: '2026-10-26', category, method: 'card', receipts: 1, gross: net, refunds: '0', net });
  serve(report({ revenue: [sale('Monthly', '500.00'), sale('Day pass', '200.00'), sale('Studio rental', '150.00'), sale('Annual', '100.00'), sale('Punch card', '30.00'), sale('Gift', '20.00'), sale('Monthly', '0.00')] }));
  render(<AnalyticsDashboardPage />);
  const card = screen.getByText('Revenue by source').closest('article')!;
  expect(within(card).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Monthly$500 50%', 'Day pass$200 20%', 'Studio rental$150 15%', 'Annual$100 10%', 'Everything else$50 5%',
  ]);
});

test('visits follow the chosen grouping, with a weekday breakdown for staffing', () => {
  const visitsByDay = [{ day: '2026-11-04', visits: 9, people: 2 }, { day: '2026-11-05', visits: 35, people: 3 }];
  serve(report({ visitsByDay, active: { approvedCheckIns: 44, activeUsers: 3 } }));
  render(<AnalyticsDashboardPage />);
  expect(screen.getByLabelText('Week of Nov 2: 44 visits; 30 days earlier: 0')).toBeTruthy();
  // 44 visits: whole-number gridlines that just clear it, not 0-60.
  expect(screen.getByRole('region', { name: 'Visits chart' }).querySelector('.period-bars__axis')!.textContent).toBe('483624120');
  const weekdays = screen.getByText('Visits by weekday').closest('article')!;
  const rows = within(weekdays).getAllByRole('listitem');
  // Averages: Oct 12 to Nov 10 has four Wednesdays and four Thursdays.
  expect(rows.map((li) => li.textContent)).toEqual(['Monday0', 'Tuesday0', 'Wednesday2.3', 'Thursday8.8', 'Friday0', 'Saturday0', 'Sunday0']);
  expect(rows[3].className).toBe('is-top');
});

test('weekday averages are not skewed by a range holding five Mondays and four Fridays', () => {
  // Oct 12 to Nov 10 has five Mondays and four Fridays; 10 visits every day.
  const visitsByDay = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10), visits: 10, people: 1 }));
  serve(report({ visitsByDay, active: { approvedCheckIns: 300, activeUsers: 1 } }));
  render(<AnalyticsDashboardPage />);
  const rows = within(screen.getByText('Visits by weekday').closest('article')!).getAllByRole('listitem');
  expect(rows.map((li) => li.textContent)).toEqual(['Monday10', 'Tuesday10', 'Wednesday10', 'Thursday10', 'Friday10', 'Saturday10', 'Sunday10']);
});

test('fill rate says "No classes in the previous 30 days" like its neighbors, not "No earlier data"', () => {
  const held = [{ id: 1, title: 'Lathe', capacity: 10, enrolled: 8, attended: 7, filledPercent: '80', status: 'scheduled', startsAt: '2026-11-01T15:00:00Z' }];
  serve(report({ classes: held }), report());
  render(<AnalyticsDashboardPage />);
  const fill = within(screen.getByLabelText('Headline numbers')).getByText('Class fill rate').closest('article')!;
  expect(fill.textContent).toContain('No classes in the previous 30 days');
});

test('a previous period of zero reads as "$0 in the previous 30 days", not as a gain', () => {
  serve(report({ revenue: [{ period: '2026-10-26', category: 'membership', method: 'card', receipts: 6, gross: '1018.00', refunds: '95.00', net: '923.00' }], active: { approvedCheckIns: 44, activeUsers: 3 } }), report());
  render(<AnalyticsDashboardPage />);
  const kpis = screen.getByLabelText('Headline numbers');
  expect(within(kpis).getByText('Net revenue').closest('article')!.textContent).toContain('$0 in the previous 30 days');
  expect(within(kpis).getByText('Visits').closest('article')!.textContent).toContain('0 in the previous 30 days');
});

test('classes: hidden when there are none; otherwise the newest six, past ones marked held', () => {
  serve(report());
  render(<AnalyticsDashboardPage />);
  expect(screen.queryByText('Classes in this period')).toBeNull();
  cleanup();

  const classes = Array.from({ length: 8 }, (_, i) => ({ id: i, title: `Class ${i}`, capacity: 10, enrolled: 5, attended: 4, filledPercent: '50', status: 'scheduled', startsAt: `2020-01-0${i + 1}T15:00:00Z` }));
  classes.push({ id: 99, title: 'Next week', capacity: 10, enrolled: 2, attended: 0, filledPercent: '20', status: 'scheduled', startsAt: '2099-01-01T15:00:00Z' });
  serve(report({ classes }));
  render(<AnalyticsDashboardPage />);
  const card = screen.getByText('Classes in this period').closest('section')!;
  // Attendance counts only classes that have started: 32 of the 40 booked came.
  expect(card.querySelector('.analytics-totals')!.textContent).toBe('Held8Seats filled42 of 90Showed up32 of 40 · 80%');
  const rows = within(card).getAllByRole('listitem');
  expect(rows).toHaveLength(6);
  expect(rows[0].textContent).toContain('Upcoming');
  expect(rows[1].textContent).toContain('Class 7');
  expect(rows[1].textContent).toMatch(/Held.*4 came/);
  expect(card.textContent).not.toContain('Starts soon');
  fireEvent.click(within(card).getByRole('button', { name: 'Show all 9 classes' }));
  expect(within(card).getAllByRole('listitem')).toHaveLength(9);
});

test('members: who joined and cancelled each period, with new members as a headline number', () => {
  const memberships = [
    { period: '2026-10-12', newMembers: 2, activeMembers: 40, expiringMembers: 0, cancelledMembers: 0 },
    { period: '2026-10-19', newMembers: 1, activeMembers: 41, expiringMembers: 1, cancelledMembers: 1 },
    { period: '2026-10-26', newMembers: 0, activeMembers: 41, expiringMembers: 0, cancelledMembers: 0 },
    { period: '2026-11-02', newMembers: 3, activeMembers: 44, expiringMembers: 0, cancelledMembers: 0 },
    { period: '2026-11-09', newMembers: 0, activeMembers: 44, expiringMembers: 0, cancelledMembers: 0 },
  ];
  serve(report({ memberships }), report({ memberships: [{ period: '2026-09-20', newMembers: 4, activeMembers: 39, expiringMembers: 0, cancelledMembers: 0 }] }));
  render(<AnalyticsDashboardPage />);
  const kpi = within(screen.getByLabelText('Headline numbers')).getByText('New members').closest('article')!;
  expect(kpi.textContent).toContain('6');
  expect(kpi.textContent).toContain('+2 vs the previous 30 days');
  const card = screen.getByText('Members by week').closest('article')!;
  expect(within(card).getByText('Joined', { selector: 'dt' }).nextElementSibling!.textContent).toBe('6');
  expect(within(card).getByText('Cancelled', { selector: 'dt' }).nextElementSibling!.textContent).toBe('1');
  expect(within(card).getByLabelText('Week of Oct 19: 1 joined, 1 cancelled')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Open Members' }).getAttribute('href')).toBe('/admin/members');
});

test('members: an empty period says so instead of drawing empty bars', () => {
  serve(report());
  render(<AnalyticsDashboardPage />);
  const card = screen.getByText('Members by week').closest('article')!;
  expect(card.textContent).toContain('Nobody joined or cancelled in this period.');
  expect(within(card).queryByRole('region')).toBeNull();
});
