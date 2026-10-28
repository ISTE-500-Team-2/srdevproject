// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClassesPage } from './ClassesPage';
import { api, ApiError } from '../lib/api';

const auth = vi.hoisted(() => ({ user: { id: 1, roles: ['admin'] as string[] } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
// jsdom has no ResizeObserver; the hold-to-cancel button measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/api')>(), api: vi.fn() }));

const HOUR = 3600000;
type Person = { userId: number; name: string; email: string; status: string };
let people: Person[];
let denyRoster = false, failFor: number | null = null, entitled = true, scheduleError: ApiError | null = null;
const course = (id: number, offsetHours: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Safety ${id}`, certificationId: 7, certificationName: 'Laser cutting', instructorId: 1, instructor: 'Morgan Reyes',
  capacity: 3, enrolled: 2, status: 'scheduled', revision: 4, roomId: 2, roomName: 'Training Room',
  startsAt: new Date(Date.now() + offsetHours * HOUR).toISOString(), endsAt: new Date(Date.now() + (offsetHours + 2) * HOUR).toISOString(),
  myStatus: null, ...extra,
});
let classes: ReturnType<typeof course>[];
const calls = (path: string, method?: string) =>
  vi.mocked(api).mock.calls.filter(([p, options]) => p === path && (options?.method ?? undefined) === method);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  auth.user = { id: 1, roles: ['admin'] };
  denyRoster = false; failFor = null; entitled = true; scheduleError = null;
  people = [
    { userId: 11, name: 'First Member', email: 'first@example.invalid', status: 'enrolled' },
    { userId: 12, name: 'Second Member', email: 'second@example.invalid', status: 'enrolled' },
  ];
  // Safety 4 has started (attendance open); Safety 5 is upcoming.
  classes = [course(4, -1), course(5, 48)];
  vi.mocked(api).mockImplementation(async (path, options) => {
    const body = options?.body as Record<string, unknown> | undefined;
    if (path.endsWith('/attendance')) {
      if (failFor === body?.userId) throw new ApiError(409, 'CONFLICT', 'Save failed; retry.');
      people = people.map(p => p.userId === body?.userId ? { ...p, status: String(body?.status) } : p);
      return undefined as never;
    }
    if (path === '/classes' && options?.method === 'POST') {
      if (scheduleError) throw scheduleError;
      return {} as never;
    }
    if (path === '/classes') return classes as never;
    if (path.endsWith('/roster')) {
      if (denyRoster) throw new ApiError(403, 'FORBIDDEN', 'Roster access removed.');
      return people as never;
    }
    if (path.endsWith('/member-roster')) return { items: [{ name: 'First M.' }], capacity: 3, enrolled: 2, seatsAvailable: 1 } as never;
    if (path === '/me/overview') return { entitlement: { membership: entitled ? { id: 1 } : null, dayPass: null } } as never;
    if (path === '/me/certifications') return [] as never;
    if (path === '/training/catalog') return [{ id: 7, name: 'Laser cutting', validityDays: 365 }] as never;
    if (path === '/rooms') return [{ id: 2, name: 'Training Room', location: 'Main floor', capacity: 18, status: 'available' }] as never;
    return undefined as never;
  });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.clearAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

async function mount() {
  await act(async () => { render(<MemoryRouter><ClassesPage /></MemoryRouter>); });
}
async function click(name: string | RegExp) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}
async function openRoster(id = 4) {
  // Started classes live under the Past tab; upcoming ones under Upcoming.
  const started = new Date(classes.find(c => c.id === id)!.startsAt).getTime() <= Date.now();
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: started ? /^Past/ : /^Upcoming/ })); });
  await click(`Roster for Safety ${id}`);
  return screen.getByRole('region', { name: `Safety ${id} roster` });
}
const radio = (panel: HTMLElement, person: string, label: 'Attended' | 'No show') =>
  within(within(panel).getByRole('group', { name: `Attendance for ${person}` })).getByLabelText(label);

test('member sees soonest classes first and registers with one click', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [course(6, 96), course(5, 48), course(4, -1, { myStatus: 'attended' })];
  await mount();
  const rows = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
  expect(rows).toEqual(['Safety 5', 'Safety 6']);
  expect(screen.getByText('You can register')).toBeTruthy();
  await click('Register for Safety 5');
  expect(calls('/classes/5/enroll', 'POST')).toHaveLength(1);
  expect(screen.getByText(/You're registered for Safety 5/)).toBeTruthy();
});

test('member without membership or day pass is sent to membership instead of a failing Register', async () => {
  auth.user = { id: 30, roles: ['member'] };
  entitled = false;
  await mount();
  expect(screen.queryByRole('button', { name: 'Register for Safety 5' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Membership or day pass needed' }).getAttribute('href')).toBe('/membership');
});

test('member detail shows first-name participants and no contact details', async () => {
  auth.user = { id: 30, roles: ['member'] };
  await mount();
  await click('Details for Safety 5');
  const detail = screen.getByRole('region', { name: 'Safety 5 details' });
  expect(within(detail).getByText('First M.')).toBeTruthy();
  expect(detail.textContent).not.toMatch(/example.invalid/);
});

test('staff banner counts unrecorded attendance from the roster of a started class', async () => {
  await mount();
  expect(screen.getByText(/Safety 4 .* needs attendance/)).toBeTruthy();
  expect(screen.getByText('2 people on the roster have no attendance recorded yet.')).toBeTruthy();
});

test('nobody is pre-marked; saving needs a note and only sends chosen people', async () => {
  await mount();
  const panel = await openRoster();
  expect((radio(panel, 'First Member', 'Attended') as HTMLInputElement).checked).toBe(false);
  expect((radio(panel, 'First Member', 'No show') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(radio(panel, 'First Member', 'Attended'));
  await click('Save 1 change');
  expect(screen.getByText(/Add a verification note/)).toBeTruthy();
  expect(calls('/classes/4/attendance', 'POST')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText(/Verification note/), { target: { value: 'Checked sign-in sheet' } });
  await click('Save 1 change');
  const sent = calls('/classes/4/attendance', 'POST');
  expect(sent).toHaveLength(1);
  expect(sent[0][1]?.body).toEqual({ userId: 11, status: 'attended', reason: 'Checked sign-in sheet' });
  expect(screen.getByText('Saved 1 of 1 change')).toBeTruthy();
});

test('a failed save keeps that person\'s choice and the note, and reports what saved', async () => {
  await mount();
  const panel = await openRoster();
  fireEvent.click(radio(panel, 'First Member', 'Attended'));
  fireEvent.click(radio(panel, 'Second Member', 'No show'));
  fireEvent.change(screen.getByLabelText(/Verification note/), { target: { value: 'Checked sign-in sheet' } });
  failFor = 12;
  await click('Save 2 changes');
  expect(screen.getByText('Saved 1 of 2 changes')).toBeTruthy();
  expect(screen.getByText(/Second Member didn't save: Save failed; retry./)).toBeTruthy();
  expect((radio(panel, 'Second Member', 'No show') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(/Verification note/) as HTMLInputElement).value).toBe('Checked sign-in sheet');
  expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy();
});

test('attendance drafts belong to their class and survive closing the panel', async () => {
  classes = [course(4, -1), course(5, -3)];
  await mount();
  let panel = await openRoster(4);
  fireEvent.click(radio(panel, 'First Member', 'No show'));
  await click('Close dialog');
  panel = await openRoster(5);
  expect((radio(panel, 'First Member', 'No show') as HTMLInputElement).checked).toBe(false);
  await click('Close dialog');
  panel = await openRoster(4);
  expect((radio(panel, 'First Member', 'No show') as HTMLInputElement).checked).toBe(true);
});

test('unsaved attendance pauses auto refresh; a pristine page refreshes every two minutes and not while hidden', async () => {
  await mount();
  const before = calls('/classes').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(calls('/classes').length).toBe(before + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(calls('/classes').length).toBe(before + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const panel = await openRoster();
  fireEvent.click(radio(panel, 'First Member', 'Attended'));
  const paused = calls('/classes').length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
    window.dispatchEvent(new Event('focus'));
  });
  expect(calls('/classes').length).toBe(paused);
  expect((radio(panel, 'First Member', 'Attended') as HTMLInputElement).checked).toBe(true);
});

test('roster contact details are cleared when a refresh denies access', async () => {
  await mount();
  const panel = await openRoster();
  expect(within(panel).getByText('first@example.invalid')).toBeTruthy();
  denyRoster = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(screen.getByText('Roster access removed.')).toBeTruthy();
  expect(screen.queryByText('first@example.invalid')).toBeNull();
});

test('plain staff can read a started roster but get no attendance controls', async () => {
  auth.user = { id: 99, roles: ['staff'] };
  await mount();
  const panel = await openRoster();
  expect(within(panel).getByText('first@example.invalid')).toBeTruthy();
  expect(within(panel).queryByRole('group', { name: /Attendance for/ })).toBeNull();
  expect(within(panel).getByText(/assigned instructor or an admin records attendance/)).toBeTruthy();
});

test('a room conflict on publish is shown on the room field and keeps the form', async () => {
  scheduleError = new ApiError(409, 'RESERVATION_CONFLICT', 'That resource is already reserved for part of this time.');
  await mount();
  await click('Schedule class');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Evening laser' } });
  fireEvent.change(screen.getByLabelText(/^Counts toward/), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText(/^Room/), { target: { value: '2' } });
  expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('18');
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Demand' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Publish class' }).closest('form')!); });
  expect(screen.getByText(/Training Room is already booked for part of this time/)).toBeTruthy();
  expect(screen.getByText('Booked for part of this time')).toBeTruthy();
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Evening laser');
});

test('cancelling sends the record revision and the staff reason', async () => {
  await mount();
  await click('More actions for Safety 5');
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Cancel class/ })); });
  expect(screen.getByText(/2 people are registered\./)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Instructor out sick' } });
  const hold = screen.getByRole('button', { name: /Hold to cancel class/ });
  // A short press does nothing; cancelling needs the full hold.
  fireEvent.keyDown(hold, { key: ' ' });
  fireEvent.keyUp(hold, { key: ' ' });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(calls('/classes/5/cancel', 'POST')).toHaveLength(0);
  fireEvent.keyDown(hold, { key: ' ' });
  await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
  expect(calls('/classes/5/cancel', 'POST')[0][1]?.body).toEqual({ expectedRevision: 4, reason: 'Instructor out sick' });
});
