// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClassesPage } from './ClassesPage';
import { api, ApiError } from '../lib/api';
import type { SupervisionSummary } from '../lib/contracts';
import { longDate, sessionName, type ClassRecord, type Course, type MemberRoster, type Room, type RosterPerson, type WorkshopTemplate } from '../components/classes/classData';
import { mockApi } from '../testing/apiMock';
import { certification, overview } from '../testing/fixtures';

const auth = vi.hoisted(() => ({ user: { id: 1, roles: ['admin'] } as { id: number; roles: string[]; isMinor?: boolean } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
// jsdom has no ResizeObserver; the hold-to-cancel button measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/api')>(), api: vi.fn() }));

const HOUR = 3600000;
let people: RosterPerson[];
let denyRoster = false, failFor: number | null = null, entitled = true, scheduleError: ApiError | null = null;
let certified = false;
let supervision: SupervisionSummary | null = null;
const course = (id: number, offsetHours: number, extra: Partial<ClassRecord> = {}): ClassRecord => ({
  id, title: `Safety ${id}`, certificationId: 7, certificationName: 'Laser cutting', instructorId: 1, instructor: 'Morgan Reyes',
  capacity: 3, enrolled: 2, status: 'scheduled', revision: 4, roomId: 2, roomName: 'Training Room',
  trainingFeeCents: 0,
  startsAt: new Date(Date.now() + offsetHours * HOUR).toISOString(), endsAt: new Date(Date.now() + (offsetHours + 2) * HOUR).toISOString(),
  myStatus: null, ...extra,
});
let classes: ClassRecord[];
const workshopCatalog: WorkshopTemplate[] = [
  { id: 1, title: 'Custom Epoxy Resin Platter', description: 'Design a statement platter.', capacity: 15 },
  { id: 2, title: 'Glow Up: Floral Resin Nightlight', description: 'Preserve real dried flowers.', capacity: 15 },
];
const calls = (path: string, method?: string) =>
  vi.mocked(api).mock.calls.filter(([p, options]) => p === path && (options?.method ?? undefined) === method);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  auth.user = { id: 1, roles: ['admin'] };
  denyRoster = false; failFor = null; entitled = true; scheduleError = null;
  certified = false;
  supervision = null;
  people = [
    { userId: 11, name: 'First Member', email: 'first@example.invalid', status: 'enrolled' },
    { userId: 12, name: 'Second Member', email: 'second@example.invalid', status: 'enrolled' },
  ];
  // Safety 4 has started (attendance open); Safety 5 is upcoming.
  classes = [course(4, -1), course(5, 48)];
  mockApi(async (path, options) => {
    const body = options?.body as Record<string, unknown> | undefined;
    if (path.endsWith('/attendance')) {
      if (failFor === body?.userId) throw new ApiError(409, 'CONFLICT', 'Save failed; retry.');
      people = people.map(p => p.userId === body?.userId ? { ...p, status: String(body?.status) } : p);
      return undefined;
    }
    if (path === '/classes' && options?.method === 'POST') {
      if (scheduleError) throw scheduleError;
      return {};
    }
    // Like the server, the list counts who on each roster still has no attendance recorded.
    if (path === '/classes') return classes.map(c => ({ pendingAttendance: people.filter(p => p.status === 'enrolled').length, ...c }));
    if (path.endsWith('/roster')) {
      if (denyRoster) throw new ApiError(403, 'FORBIDDEN', 'Roster access removed.');
      return people;
    }
    if (path.endsWith('/member-roster')) return { items: [{ name: 'First M.' }], capacity: 3, enrolled: 2, seatsAvailable: 1 } satisfies MemberRoster;
    if (path === '/me/overview') return overview({ entitlement: { membership: entitled, dayPass: false } });
    if (path === '/me/supervision') return supervision;
    if (path === '/me/certifications') return certified ? [certification({ id: 7, name: 'Laser cutting', valid: true })] : [];
    if (path === '/classes/catalog') return workshopCatalog;
    if (path === '/training/catalog') return [{ id: 7, name: 'Laser cutting', validityDays: 365 }] satisfies Course[];
    if (path === '/rooms') return [{ id: 2, name: 'Training Room', location: 'Main floor', capacity: 18, status: 'available' }] satisfies Room[];
    // Registering and cancelling reply with no body the page reads.
    if (options?.method === 'POST' && /^\/classes\/\d+\/(enroll|cancel)$/.test(path)) return undefined;
    throw new Error(`Unexpected request ${options?.method ?? 'GET'} ${path}`);
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
/** Register buttons name the session's day, so same-titled classes can be told apart. */
const registerFor = (id: number) => `Register for ${sessionName(classes.find(c => c.id === id)!)}`;
const startingWith = (prefix: string) => (name: string) => name.startsWith(prefix);
const radio = (panel: HTMLElement, person: string, label: 'Attended' | 'No show') =>
  within(within(panel).getByRole('group', { name: `Attendance for ${person}` })).getByLabelText(label);

test('member sees soonest classes first and registers with one click', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [course(6, 96), course(5, 48), course(4, -1, { myStatus: 'attended' })];
  await mount();
  const rows = screen.getAllByRole('heading', { level: 3 }).filter(h => h.closest('.class-row')).map(h => h.textContent);
  expect(rows).toEqual(['Safety 5', 'Safety 6']);
  expect(screen.getByText('You can register')).toBeTruthy();
  await click(registerFor(5));
  expect(calls('/classes/5/enroll', 'POST')).toHaveLength(1);
  expect(screen.getByText(/You're registered for Safety 5/)).toBeTruthy();
});

test('member without membership or day pass is sent to membership instead of a failing Register', async () => {
  auth.user = { id: 30, roles: ['member'] };
  entitled = false;
  await mount();
  expect(screen.queryByRole('button', { name: startingWith('Register for Safety 5') })).toBeNull();
  expect(screen.getByRole('link', { name: 'Membership or day pass needed' }).getAttribute('href')).toBe('/membership');
});

test('a minor without a sponsoring adult sees why Register is off and where to link one', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  supervision = { isMinor: true, marker: 'Under 18', sponsor: null, sponsorEligible: false, visit: null, pendingRequests: [] };
  await mount();
  const register = screen.getByRole('button', { name: `${registerFor(5)}: link a sponsoring adult to sign up` }) as HTMLButtonElement;
  expect(register.disabled).toBe(true);
  expect(screen.getByText('Link a sponsoring adult to sign up')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Link a sponsor to sign up' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Link a sponsor' }).getAttribute('href')).toBe('/');
  expect(screen.queryByText('You can register')).toBeNull();
  await click('Details for Safety 5');
  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('button', { name: 'Register for class' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByText('Link a sponsoring adult to sign up')).toBeTruthy();
  expect(calls('/classes/5/enroll', 'POST')).toHaveLength(0);
});

test('a minor whose linked sponsor is inactive is told so; an active sponsor lets them register', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  supervision = { isMinor: true, marker: 'Under 18', sponsor: { id: 7, name: 'Dana Reyes', revision: 1 }, sponsorEligible: false, visit: null, pendingRequests: [] };
  await mount();
  expect(screen.getByRole('heading', { name: 'Your sponsor can’t sign you up' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Link a sponsor' })).toBeNull();
  expect((screen.getByRole('button', { name: startingWith(`${registerFor(5)}: your sponsoring adult`) }) as HTMLButtonElement).disabled).toBe(true);
  // Staff restore the sponsor while the page stays open; the next refresh picks it up.
  supervision = { ...supervision, sponsorEligible: true };
  await act(async () => { vi.advanceTimersByTime(15000); });
  expect(await screen.findByText('You can register')).toBeTruthy();
  await click(registerFor(5));
  expect(calls('/classes/5/enroll', 'POST')).toHaveLength(1);
});

test('a minor stays blocked while the sponsor check fails, with a retry', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  const base = vi.mocked(api).getMockImplementation()!;
  let fail = true;
  mockApi(async (path, options) => {
    if (path === '/me/supervision' && fail) throw new ApiError(503, 'UNAVAILABLE', 'Sponsor check failed.');
    return base(path, options);
  });
  supervision = { isMinor: true, marker: 'Under 18', sponsor: { id: 7, name: 'Dana Reyes', revision: 1 }, sponsorEligible: true, visit: null, pendingRequests: [] };
  await mount();
  expect(screen.getByRole('heading', { name: 'Checking your sponsor' })).toBeTruthy();
  expect((screen.getByRole('button', { name: startingWith(`${registerFor(5)}: checking your sponsoring adult`) }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('Sponsor check failed.');
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Details for Safety 5' })[0]!); });
  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('button', { name: /Register/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByText('Checking your sponsoring adult')).toBeTruthy();
  fail = false;
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!); });
  expect(await screen.findByText('You can register')).toBeTruthy();
});

test('a known sponsor problem still blocks a minor while the membership check fails', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  const base = vi.mocked(api).getMockImplementation()!;
  mockApi(async (path, options) => {
    if (path === '/me/overview') throw new ApiError(503, 'UNAVAILABLE', 'Overview failed.');
    return base(path, options);
  });
  supervision = { isMinor: true, marker: 'Under 18', sponsor: null, sponsorEligible: false, visit: null, pendingRequests: [] };
  await mount();
  expect((screen.getByRole('button', { name: startingWith(`${registerFor(5)}: link a sponsoring adult`) }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('heading', { name: 'Link a sponsor to sign up' })).toBeTruthy();
});

test('a slow sponsor check is not restarted by the page refresh', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  const base = vi.mocked(api).getMockImplementation()!;
  let answer: ((value: SupervisionSummary) => void) | null = null;
  mockApi(async (path, options) => {
    if (path === '/me/supervision') return new Promise<SupervisionSummary>(resolve => { answer = resolve; });
    return base(path, options);
  });
  await mount();
  expect(screen.getByRole('heading', { name: 'Checking your sponsor' })).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(16000); });
  expect(calls('/me/supervision')).toHaveLength(1);
  await act(async () => { answer!({ isMinor: true, marker: 'Under 18', sponsor: { id: 7, name: 'Dana Reyes', revision: 1 }, sponsorEligible: true, visit: null, pendingRequests: [] }); });
  expect(await screen.findByText('You can register')).toBeTruthy();
});

test('registering for required training shows and submits the one-time $20 fee', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [course(5, 48, { trainingFeeCents: 2000 })];
  await mount();
  expect(screen.getByText('$20.00 total for training; no extra course fee')).toBeTruthy();
  await click(registerFor(5));
  expect(calls('/classes/5/enroll', 'POST')[0][1]?.body).toEqual({ expectedTrainingFeeCents: 2000 });
});

test('a certified member registering again is not charged another training fee', async () => {
  auth.user = { id: 30, roles: ['member'] };
  certified = true;
  classes = [course(5, 48, { trainingFeeCents: 2000 })];
  await mount();
  expect(screen.getByText('Training fee already covered')).toBeTruthy();
  await click(registerFor(5));
  expect(calls('/classes/5/enroll', 'POST')[0][1]?.body).toEqual({ expectedTrainingFeeCents: 0 });
});

test('paid training stays covered before certification approval and shows no extra course fee', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [course(5, 48, { trainingFeeCents: 2000, trainingFeeCovered: true })];
  await mount();
  await click('Details for Safety 5');
  const detail = screen.getByRole('region', { name: 'Safety 5 details' });
  expect(within(detail).getByText('Total: $0.00')).toBeTruthy();
  expect(within(detail).getByText(/no extra course fee/)).toBeTruthy();
  await click('Register for class');
  expect(calls('/classes/5/enroll', 'POST')[0][1]?.body).toEqual({ expectedTrainingFeeCents: 0 });
});

test('a class the shop cancelled is not listed as a past class waiting for attendance', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [
    course(5, 48),
    course(4, -3, { myStatus: 'attended' }),
    course(6, -2, { status: 'cancelled', myStatus: 'enrolled' }),
    // Attendance was recorded before the class was cancelled, so it really happened and stays.
    course(7, -4, { status: 'cancelled', myStatus: 'attended' }),
  ];
  await mount();
  expect(screen.getByText('Past classes (2)')).toBeTruthy();
  expect(screen.getByText(/^Safety 4 ·/)).toBeTruthy();
  expect(screen.getByText(/^Safety 7 ·/)).toBeTruthy();
  expect(screen.queryByText(/^Safety 6 ·/)).toBeNull();
  expect(screen.queryByText('Attendance not recorded yet')).toBeNull();
});

test('creative workshop rows are not described as $0 training', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [
    course(5, 48, { trainingFeeCents: 2000 }),
    course(6, 72, { title: 'Resin night', certificationId: null, certificationName: 'Creative workshop', catalogId: 1, trainingFeeCents: null }),
  ];
  await mount();
  const row = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('li')!;
  expect(within(row('Safety 5')).getByText('$20.00 total for training; no extra course fee')).toBeTruthy();
  expect(row('Resin night').textContent).not.toMatch(/total for training|Training fee/);
});

test('screen readers hear each session\'s day, and its buttons name that day', async () => {
  auth.user = { id: 30, roles: ['member'] };
  const mine = course(5, 48, { title: 'Laser basics', instructorId: 9, myStatus: 'enrolled' });
  const later = course(6, 8 * 24, { title: 'Laser basics', instructorId: 9 });
  const taught = course(7, 72, { title: 'Wood lathe', instructorId: 30 });
  classes = [mine, later, taught];
  await mount();
  // Same title twice: the decorative date rail is hidden, so the day has to be in the text.
  const row = screen.getByRole('button', { name: `Register for Laser basics on ${longDate(later.startsAt)}` }).closest('li')!;
  expect(within(row).getByText(longDate(later.startsAt))).toBeTruthy();
  const details = within(row).getByRole('button', { name: 'Details for Laser basics' });
  expect(document.getElementById(details.getAttribute('aria-describedby')!)?.textContent).toBe(longDate(later.startsAt));
  expect(screen.getByRole('button', { name: `Withdraw from Laser basics on ${longDate(mine.startsAt)}` })).toBeTruthy();
  const teaching = screen.getByRole('region', { name: 'Classes you teach' });
  expect(within(teaching).getByText(new RegExp(longDate(taught.startsAt)))).toBeTruthy();
  expect(within(teaching).getByRole('button', { name: `Roster for Wood lathe on ${longDate(taught.startsAt)}` })).toBeTruthy();
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

test('attendance counts come with the class list, so refreshing never reads one roster per class', async () => {
  classes = [course(4, -1), course(6, -3, { pendingAttendance: 0 }), course(5, 48)];
  await mount();
  expect(screen.getByText(/Safety 4 .* needs attendance/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); window.dispatchEvent(new Event('focus')); });
  expect(vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith('/roster'))).toHaveLength(0);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Past/ })); });
  const recorded = screen.getByRole('heading', { level: 3, name: 'Safety 6' }).closest('.class-table__row')!;
  expect(within(recorded as HTMLElement).getByText('Recorded')).toBeTruthy();
});

test('an instructor sees which of their past classes still need attendance', async () => {
  auth.user = { id: 1, roles: ['member', 'instructor'] };
  classes = [course(4, -1), course(6, -3, { pendingAttendance: 0 }), course(5, 48)];
  await mount();
  const teaching = screen.getByRole('heading', { name: 'Classes you teach' }).closest('section')!;
  expect(within(teaching).getByText('2 people need attendance')).toBeTruthy();
  expect(within(teaching).getAllByText(/need attendance|needs attendance/)).toHaveLength(1);
});

test('a day pass for the class day lets a member register ahead, and a membership ending first does not', async () => {
  auth.user = { id: 30, roles: ['member'] };
  entitled = false;
  classes = [course(5, 48, { myEntitled: true }), course(6, 96, { myEntitled: false })];
  await mount();
  expect(screen.getByRole('button', { name: 'Register for Safety 5' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Register for Safety 6' })).toBeNull();
  expect(screen.getAllByRole('link', { name: 'Membership or day pass needed' })).toHaveLength(1);
  // The side panel agrees with the rows rather than with today's answer.
  expect(screen.getByRole('heading', { name: 'You can register for some classes' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Membership or day pass needed' })).toBeNull();
});

test('class tabs move with the arrow keys, and a menu choice hands focus back to its button', async () => {
  await mount();
  const upcoming = screen.getByRole('tab', { name: /^Upcoming/ });
  expect(upcoming.tabIndex).toBe(0);
  expect(screen.getByRole('tab', { name: /^Past/ }).tabIndex).toBe(-1);
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(upcoming.id);
  upcoming.focus();
  await act(async () => { fireEvent.keyDown(upcoming, { key: 'ArrowRight' }); });
  const attendance = screen.getByRole('tab', { name: /^Needs attendance/ });
  expect(document.activeElement).toBe(attendance);
  expect(attendance.getAttribute('aria-selected')).toBe('true');
  await act(async () => { fireEvent.keyDown(attendance, { key: 'End' }); });
  expect(screen.getByRole('tab', { name: /^Cancelled/ }).getAttribute('aria-selected')).toBe('true');
  await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Home' }); });
  expect(screen.getByRole('tab', { name: /^Upcoming/ }).getAttribute('aria-selected')).toBe('true');

  const more = screen.getByRole('button', { name: 'More actions for Safety 5' });
  await act(async () => { fireEvent.click(more); });
  const again = screen.getByRole('menuitem', { name: /Schedule again/ });
  expect(document.activeElement).toBe(again);
  await act(async () => { fireEvent.keyDown(again, { key: 'ArrowDown' }); });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Cancel class/ }));
  await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(more);
  await act(async () => { fireEvent.click(more); });
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Cancel class/ })); });
  // The dialog returns focus to the button that opened it.
  await click('Keep class');
  expect(document.activeElement).toBe(more);
});

test('a mouse press that blurs the row menu without moving focus still runs the chosen item', async () => {
  await mount();
  const more = screen.getByRole('button', { name: 'More actions for Safety 5' });
  // Safari and Firefox on Mac blur the focused item on mouse press without focusing the pressed one.
  const press = async (target: Element) => {
    await act(async () => { fireEvent.focusOut(document.activeElement!, { relatedTarget: null }); });
    await act(async () => { fireEvent.click(target); });
  };
  await act(async () => { fireEvent.click(more); });
  await press(screen.getByRole('menuitem', { name: /Cancel class/ }));
  expect(screen.getByRole('button', { name: 'Keep class' })).toBeTruthy();
  await click('Keep class');
  // Pressing "More actions" again closes the open menu instead of reopening it.
  await act(async () => { fireEvent.click(more); });
  await press(more);
  expect(screen.queryByRole('menu')).toBeNull();
  // Focus that moves on to something outside the row's actions still closes the menu.
  await act(async () => { fireEvent.click(more); });
  await act(async () => {
    fireEvent.focusOut(document.activeElement!, { relatedTarget: screen.getByRole('tab', { name: /^Upcoming/ }) });
  });
  expect(screen.queryByRole('menu')).toBeNull();
});

test('nobody is pre-marked; saving needs a note and only sends chosen people', async () => {
  await mount();
  const panel = await openRoster();
  expect((radio(panel, 'First Member', 'Attended') as HTMLInputElement).checked).toBe(false);
  expect((radio(panel, 'First Member', 'No show') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(radio(panel, 'First Member', 'Attended'));
  await click('Save 1 change');
  // Announced, and focus goes to the field that blocked the save.
  expect(screen.getByRole('alert').textContent).toMatch(/Add a verification note/);
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Verification note/, description: /Add a verification note/ }));
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

test('unsaved attendance pauses auto refresh; a pristine page refreshes every 15 seconds and not while hidden', async () => {
  await mount();
  const before = calls('/classes').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(calls('/classes').length).toBe(before + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(calls('/classes').length).toBe(before + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const panel = await openRoster();
  fireEvent.click(radio(panel, 'First Member', 'Attended'));
  const paused = calls('/classes').length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
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
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
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
  expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('15');
  expect((screen.getByRole('spinbutton') as HTMLInputElement).max).toBe('15');
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Demand' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Publish class' }).closest('form')!); });
  expect(screen.getByText(/Training Room is already booked for part of this time/)).toBeTruthy();
  expect(screen.getByText('Booked for part of this time')).toBeTruthy();
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Evening laser');
});

test('the schedule form asks before discarding edits on Escape, a backdrop click or Cancel', async () => {
  await mount();
  await click('Schedule class');
  // Nothing entered yet, so Escape just closes it.
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  expect(screen.queryByRole('dialog', { name: 'Schedule a class' })).toBeNull();
  await click('Schedule class');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Evening laser' } });
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await click('Keep editing');
  await act(async () => { fireEvent.mouseDown(document.querySelector('.modal-backdrop')!); });
  await click('Keep editing');
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Evening laser');
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Schedule a class' })).getByRole('button', { name: 'Cancel' })); });
  expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
  await click('Discard changes');
  expect(screen.queryByRole('dialog', { name: 'Schedule a class' })).toBeNull();
});

test('the schedule form stays open while it is publishing', async () => {
  await mount();
  const served = vi.mocked(api).getMockImplementation()!;
  mockApi((path, options) => path === '/classes' && options?.method === 'POST' ? new Promise(() => {}) : served(path, options));
  await click('Schedule class');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Evening laser' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Publish class' }).closest('form')!); });
  expect(screen.getByRole('button', { name: 'Publishing…' })).toBeTruthy();
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  expect(screen.getByRole('dialog', { name: 'Schedule a class' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
});

test('scheduling a class again shows its instructor by name, not an ID', async () => {
  await mount();
  await click('More actions for Safety 5');
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Schedule again/ })); });
  const dialog = screen.getByRole('dialog', { name: 'Schedule a class' });
  expect(within(dialog).getByText('Morgan Reyes')).toBeTruthy();
  expect(dialog.textContent).not.toMatch(/Instructor #/);
  expect(dialog.querySelector<HTMLInputElement>('input[name="instructorId"]')?.value).toBe('1');
});

test('a time problem is announced on the time fields, and Publish takes the user to the time to change', async () => {
  await mount();
  await click('Schedule class');
  const ends = screen.getByLabelText('Ends');
  fireEvent.change(ends, { target: { value: '17:00' } });
  expect(screen.getByRole('alert').textContent).toBe('End time must be after the start time.');
  expect(ends.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Starts').getAttribute('aria-invalid')).toBe('false');
  expect(ends.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  const publish = screen.getByRole('button', { name: 'Publish class' }) as HTMLButtonElement;
  expect(publish.disabled).toBe(false);
  await act(async () => { fireEvent.submit(publish.closest('form')!); });
  expect(document.activeElement).toBe(ends);
  expect(calls('/classes', 'POST')).toHaveLength(0);
});

test('a start time that has already passed is announced on Starts, and Publish takes the user there', async () => {
  await mount();
  await click('Schedule class');
  const date = screen.getByLabelText('Date') as HTMLInputElement;
  const starts = screen.getByLabelText('Starts');
  const ends = screen.getByLabelText('Ends');
  // Midnight today (the earliest date the picker allows) has always passed; the length is fine.
  fireEvent.change(date, { target: { value: date.min } });
  fireEvent.change(starts, { target: { value: '00:00' } });
  fireEvent.change(ends, { target: { value: '02:00' } });
  expect(screen.getByRole('alert').textContent).toBe('Pick a start time in the future.');
  expect(starts.getAttribute('aria-invalid')).toBe('true');
  expect(ends.getAttribute('aria-invalid')).toBe('false');
  expect(starts.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  const publish = screen.getByRole('button', { name: 'Publish class' });
  await act(async () => { fireEvent.submit(publish.closest('form')!); });
  expect(document.activeElement).toBe(starts);
  expect(calls('/classes', 'POST')).toHaveLength(0);
});

test('cancelling sends the record revision and the staff reason', async () => {
  await mount();
  await click('More actions for Safety 5');
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Cancel class/ })); });
  expect(screen.getByText(/2 people are registered\./)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Instructor out sick' } });
  const hold = screen.getByRole('button', { name: /Hold to cancel class/ });
  // A short press never cancels on its own: it only asks for a second press. The full hold cancels.
  fireEvent.keyDown(hold, { key: ' ' });
  fireEvent.keyUp(hold, { key: ' ' });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(calls('/classes/5/cancel', 'POST')).toHaveLength(0);
  expect(hold.textContent).toContain('Press again to confirm');
  fireEvent.keyDown(hold, { key: ' ' });
  await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
  expect(calls('/classes/5/cancel', 'POST')[0][1]?.body).toEqual({ expectedRevision: 4, reason: 'Instructor out sick' });
});

test('a class that started while the cancel dialog was open is not cancelled, and the list refreshes', async () => {
  await mount();
  await click('More actions for Safety 5');
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /Cancel class/ })); });
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Instructor out sick' } });
  const served = vi.mocked(api).getMockImplementation()!;
  mockApi(async (path, options) => {
    if (path === '/classes/5/cancel') throw new ApiError(409, 'CLASS_CLOSED', 'Only a scheduled class that hasn\'t started yet can be cancelled.');
    return served(path, options);
  });
  const before = calls('/classes').length;
  // The full hold is the only way to cancel.
  fireEvent.keyDown(screen.getByRole('button', { name: /Hold to cancel class/ }), { key: ' ' });
  await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
  expect(calls('/classes/5/cancel', 'POST')).toHaveLength(1);
  expect(screen.getByText(/already started or been cancelled/)).toBeTruthy();
  expect(calls('/classes').length).toBeGreaterThan(before);
});

test('an instructor already teaching at that time is flagged on the Instructor field', async () => {
  scheduleError = new ApiError(409, 'INSTRUCTOR_CONFLICT', 'This instructor is already teaching another class at this time.');
  await mount();
  await click('Schedule class');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Evening laser' } });
  fireEvent.change(screen.getByLabelText(/^Counts toward/), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText(/^Room/), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Demand' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Publish class' }).closest('form')!); });
  expect(screen.getByText(/already teaching another class at this time\. Pick another instructor or time\./)).toBeTruthy();
  expect(screen.getByText('Teaching another class at this time')).toBeTruthy();
  expect(screen.queryByText('Booked for part of this time')).toBeNull();
});

test('creative workshop details show the description without promising certification approval',async()=>{
 auth.user={id:30,roles:['member']};
 classes=[course(5,48,{certificationId:null,certificationName:'Creative workshop',catalogId:1,trainingFeeCents:null,description:'Build a resin platter with an instructor.'})];
 await mount();await click('Details for Safety 5');
 const detail=screen.getByRole('region',{name:'Safety 5 details'});
 expect(within(detail).getByText('Build a resin platter with an instructor.')).toBeTruthy();
 expect(within(detail).getByText(/This creative workshop does not grant equipment certification/)).toBeTruthy();
 expect(detail.textContent).not.toContain('approved separately');
 expect(within(detail).queryByRole('region',{name:'Class price breakdown'})).toBeNull();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Register for class'}));});
 expect(calls('/classes/5/enroll','POST')[0][1]?.body).toEqual({expectedTrainingFeeCents:0});
});

test('members see scheduled workshops as normal rows and the rest as cards, every one with a photo', async () => {
  auth.user = { id: 30, roles: ['member'] };
  classes = [
    course(5, 48),
    // Staff renamed this session; its photo still comes from the catalog workshop it was made from.
    course(6, 72, { title: 'Thursday resin night', certificationId: null, certificationName: 'Creative workshop', catalogId: 2 }),
  ];
  await mount();
  // Workshops get their own filter chip because the API names their group "Creative workshop".
  expect(screen.getByRole('button', { name: /^Creative workshop/ }).getAttribute('aria-pressed')).toBe('false');
  const row = screen.getByRole('heading', { level: 3, name: 'Thursday resin night' }).closest('li')!;
  expect(within(row).getByText('Creative workshop')).toBeTruthy();
  expect(row.querySelector('.class-thumb img')?.getAttribute('src')).toBe('/assets/resin-nightlight.webp');
  const cards = screen.getByRole('region', { name: 'More creative workshops' });
  // The nightlight already has a session, so only the platter is listed as a card.
  expect(within(cards).queryByText('Glow Up: Floral Resin Nightlight')).toBeNull();
  const card = within(cards).getByRole('heading', { name: 'Custom Epoxy Resin Platter' }).closest('li')!;
  expect(within(card).getByText('Not scheduled yet')).toBeTruthy();
  expect(within(card).queryByRole('button')).toBeNull();
  expect(card.querySelector('img')?.getAttribute('src')).toBe('/assets/resin-platter.webp');
  for (const img of document.querySelectorAll('.class-row .class-thumb img')) expect(img.getAttribute('src')).toMatch(/\.webp$/);
  // Filtering to an equipment certification hides the workshop cards.
  await click(/^Laser cutting/);
  expect(screen.queryByRole('region', { name: 'More creative workshops' })).toBeNull();
});

test('staff schedule a creative workshop from the picker without a certification', async () => {
  await mount();
  expect(screen.queryByText('More creative workshops')).toBeNull();
  await click('Schedule class');
  expect(screen.getByLabelText(/^Counts toward/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByLabelText(/Creative workshop/)); });
  expect(screen.queryByLabelText(/^Counts toward/)).toBeNull();
  expect(screen.getByText(/Creative workshops don't grant equipment certification/)).toBeTruthy();
  expect((screen.getByRole('radio', { name: /Creative workshop/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('radio', { name: /Equipment training/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText(/^Workshop/), { target: { value: '2' } });
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Glow Up: Floral Resin Nightlight');
  expect((screen.getByLabelText(/^Description/) as HTMLTextAreaElement).value).toBe('Preserve real dried flowers.');
  expect(screen.getByText('28 / 4000')).toBeTruthy();
  expect(screen.getByText('Max 15 per class')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^Room/), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Sponsor series' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Publish class' }).closest('form')!); });
  const body = calls('/classes', 'POST')[0][1]?.body as Record<string, unknown>;
  expect(body).toMatchObject({ title: 'Glow Up: Floral Resin Nightlight', certificationId: null, catalogId: 2, capacity: 15 });
});

test('a slow class list is left to finish instead of being restarted by the next refresh', async () => {
  await mount();
  const original = vi.mocked(api).getMockImplementation()!;
  mockApi((path, options) => path === '/classes' ? new Promise(() => {}) : original(path, options));
  const before = calls('/classes').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(calls('/classes').length).toBe(before + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(45000); });
  expect(calls('/classes').length).toBe(before + 1);
});
