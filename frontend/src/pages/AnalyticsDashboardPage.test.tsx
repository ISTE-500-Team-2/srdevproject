// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
import { useApi } from '../lib/useApi';
vi.mock('../lib/useApi', () => ({ useApi: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

test.each(['From', 'Through'])('historical dates can be entered starting with %s without requesting an invalid range', (first) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T16:00:00Z'));
  vi.mocked(useApi).mockReturnValue({ data: null, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
  const from = screen.getByLabelText('From') as HTMLInputElement;
  const through = screen.getByLabelText('Through') as HTMLInputElement;
  fireEvent.change(first === 'From' ? from : through, { target: { value: first === 'From' ? '2026-01-01' : '2026-01-31' } });
  expect(screen.getByRole('alert').textContent).toMatch(/93 days/);
  expect(vi.mocked(useApi).mock.calls.at(-2)![0]).toContain('from=2026-09-28&to=2026-10-27');
  fireEvent.change(first === 'From' ? through : from, { target: { value: first === 'From' ? '2026-01-31' : '2026-01-01' } });
  expect([from.value, through.value]).toEqual(['2026-01-01', '2026-01-31']);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.mocked(useApi).mock.calls.at(-2)![0]).toContain('from=2026-01-01&to=2026-01-31');
  // Clearing a date is allowed; the last valid range remains applied.
  fireEvent.change(from, { target: { value: '' } });
  expect(from.value).toBe('');
  expect(vi.mocked(useApi).mock.calls.at(-2)![0]).toContain('from=2026-01-01&to=2026-01-31');
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'month' } });
  fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
  expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-01');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('today count and remaining visitors use the full total, not the capped recent list', () => {
  const checkedInToday = Array.from({ length: 50 }, (_, i) => ({ userId: i, name: `Visitor ${i}`, location: 'Studio', at: '2026-10-27T15:00:00Z', method: 'portal' }));
  vi.mocked(useApi).mockReturnValue({ data: { from: '2026-10-01', to: '2026-10-27', period: 'daily', timeZone: 'America/New_York', generatedAt: '2026-10-27T16:00:00Z', revenue: [], classes: [], active: { approvedCheckIns: 75, activeUsers: 75 }, visitsByDay: [], checkedInToday, checkedInTodayCount: 75, notes: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  expect(screen.getByText('75 people')).toBeTruthy();
  expect(screen.getByText('+69 more')).toBeTruthy();
  expect(screen.queryByText('Visitor 6')).toBeNull();
});

test('daily visit values including zero-count days are readable without hover', () => {
  vi.mocked(useApi).mockReturnValue({ data: { from: '2026-10-25', to: '2026-10-27', period: 'daily', timeZone: 'America/New_York', generatedAt: '2026-10-27T16:00:00Z', revenue: [], classes: [], active: { approvedCheckIns: 9, activeUsers: 9 }, visitsByDay: [{ day: '2026-10-25', visits: 2 }, { day: '2026-10-26', visits: 0 }, { day: '2026-10-27', visits: 7 }], checkedInToday: [], notes: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() });
  render(<AnalyticsDashboardPage />);
  fireEvent.click(screen.getByText('Show daily visit counts'));
  const table = screen.getByRole('table', { name: 'Visits per day' });
  expect(within(table).getAllByRole('row').map(row => row.textContent)).toEqual(['DateVisits', '2026-10-252', '2026-10-260', '2026-10-277']);
});
