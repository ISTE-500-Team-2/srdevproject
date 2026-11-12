// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClassesPage } from './ClassesPage';
import { api, ApiError } from '../lib/api';

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
type Person = { userId: number; name: string; email: string; status: string };
let people: Person[];
let denyRoster = false, failFor: number | null = null, entitled = true, scheduleError: ApiError | null = null;
let certified = false;
let supervision: Record<string, unknown> | null = null;
const course = (id: number, offsetHours: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Safety ${id}`, certificationId: 7, certificationName: 'Laser cutting', instructorId: 1, instructor: 'Morgan Reyes',
  capacity: 3, enrolled: 2, status: 'scheduled', revision: 4, roomId: 2, roomName: 'Training Room',
  trainingFeeCents: 0,
  startsAt: new Date(Date.now() + offsetHours * HOUR).toISOString(), endsAt: new Date(Date.now() + (offsetHours + 2) * HOUR).toISOString(),
  myStatus: null, ...extra,
});
let classes: ReturnType<typeof course>[];
const workshopCatalog = [
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
    if (path === '/me/supervision') return supervision as never;
    if (path === '/me/certifications') return (certified ? [{ id: 7, valid: true }] : []) as never;
    if (path === '/classes/catalog') return workshopCatalog as never;
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
  const rows = screen.getAllByRole('heading', { level: 3 }).filter(h => h.closest('.class-row')).map(h => h.textContent);
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

test('a minor without a sponsoring adult sees why Register is off and where to link one', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  supervision = { isMinor: true, marker: 'Under 18', sponsor: null, sponsorEligible: false, visit: null, pendingRequests: [] };
  await mount();
  const register = screen.getByRole('button', { name: 'Register for Safety 5: link a sponsoring adult to sign up' }) as HTMLButtonElement;
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
  expect((screen.getByRole('button', { name: /^Register for Safety 5: your sponsoring adult/ }) as HTMLButtonElement).disabled).toBe(true);
  // Staff restore the sponsor while the page stays open; the next refresh picks it up.
  supervision = { ...supervision, sponsorEligible: true };
  await act(async () => { vi.advanceTimersByTime(15000); });
  expect(await screen.findByText('You can register')).toBeTruthy();
  await click('Register for Safety 5');
  expect(calls('/classes/5/enroll', 'POST')).toHaveLength(1);
});

test('a minor stays blocked while the sponsor check fails, with a retry', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  const base = vi.mocked(api).getMockImplementation()!;
  let fail = true;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/me/supervision' && fail) throw new ApiError(503, 'UNAVAILABLE', 'Sponsor check failed.');
    return base(path, options);
  });
  supervision = { isMinor: true, marker: 'Under 18', sponsor: { id: 7, name: 'Dana Reyes', revision: 1 }, sponsorEligible: true, visit: null, pendingRequests: [] };
  await mount();
  expect(screen.getByRole('heading', { name: 'Checking your sponsor' })).toBeTruthy();
  expect((screen.getByRole('button', { name: /^Register for Safety 5: checking your sponsoring adult/ }) as HTMLButtonElement).disabled).toBe(true);
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
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/me/overview') throw new ApiError(503, 'UNAVAILABLE', 'Overview failed.');
    return base(path, options);
  });
  supervision = { isMinor: true, marker: 'Under 18', sponsor: null, sponsorEligible: false, visit: null, pendingRequests: [] };
  await mount();
  expect((screen.getByRole('button', { name: /^Register for Safety 5: link a sponsoring adult/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('heading', { name: 'Link a sponsor to sign up' })).toBeTruthy();
});

test('a slow sponsor check is not restarted by the page refresh', async () => {
  auth.user = { id: 31, roles: ['member'], isMinor: true };
  const base = vi.mocked(api).getMockImplementation()!;
  let answer: ((value: unknown) => void) | null = null;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/me/supervision') return new Promise(resolve => { answer = resolve; }) as never;
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
  await click('Register for Safety 5');
  expect(calls('/classes/5/enroll', 'POST')[0][1]?.body).toEqual({ expectedTrainingFeeCents: 2000 });
});

test('a certified member registering again is not charged another training fee', async () => {
  auth.user = { id: 30, roles: ['member'] };
  certified = true;
  classes = [course(5, 48, { trainingFeeCents: 2000 })];
  await mount();
  expect(screen.getByText('Training fee already covered')).toBeTruthy();
  await click('Register for Safety 5');
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
  vi.mocked(api).mockImplementation(((path: string, ...rest: unknown[]) =>
    path === '/classes' ? new Promise(() => {}) : (original as (...a: unknown[]) => unknown)(path, ...rest)) as never);
  const before = calls('/classes').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(calls('/classes').length).toBe(before + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(45000); });
  expect(calls('/classes').length).toBe(before + 1);
});
