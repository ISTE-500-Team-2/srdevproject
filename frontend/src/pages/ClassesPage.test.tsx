// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClassesPage } from './ClassesPage';
import { api, ApiError } from '../lib/api';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, roles: ['admin'] } }) }));
vi.mock('../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/api')>(), api: vi.fn() }));

let denyRoster = false, failSave = false;
let people: { userId: number; name: string; email: string; status: string }[];
const course = (id: number) => ({ id, title: `Safety ${id}`, instructorId: 1, instructor: 'Instructor', certificationName: 'Safety', capacity: 3, enrolled: 2, status: 'scheduled', startsAt: new Date(Date.now() - 3600000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), myStatus: null });
const getCount = (path: string) => vi.mocked(api).mock.calls.filter(([p, options]) => p === path && !options?.method).length;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  denyRoster = false; failSave = false;
  people = [
    { userId: 11, name: 'First Member', email: 'first@example.invalid', status: 'enrolled' },
    { userId: 12, name: 'Second Member', email: 'second@example.invalid', status: 'enrolled' },
  ];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.endsWith('/attendance')) {
      if (failSave) throw new ApiError(409, 'CONFLICT', 'Save failed; retry your attendance.');
      const body = options?.body as { userId: number; status: string };
      people = people.map(p => p.userId === body.userId ? { ...p, status: body.status } : p);
      return undefined as never;
    }
    if (path === '/classes') return [course(4), course(5)] as never;
    if (path.endsWith('/roster')) {
      if (denyRoster) throw new ApiError(403, 'FORBIDDEN', 'Roster access removed.');
      return people as never;
    }
    return [] as never;
  });
});
afterEach(() => {
  cleanup();vi.useRealTimers();vi.clearAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

async function openRoster(id = 4) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `View roster for Safety ${id}` })); });
}
async function mount() {
  await act(async () => { render(<MemoryRouter><ClassesPage /></MemoryRouter>); });
  await openRoster();
}
async function refresh() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh classes and rosters' })); });
}

test('unsaved attendance, cancellation and schedule drafts survive timer, focus, visibility and manual refresh', async () => {
  await mount();
  const note = screen.getAllByLabelText('Verification note')[0] as HTMLInputElement;
  const attendance = screen.getAllByLabelText('Observed attendance')[0] as HTMLSelectElement;
  const cancel = screen.getAllByLabelText('Cancellation reason')[0] as HTMLInputElement;
  const title = screen.getByLabelText('Title') as HTMLInputElement;
  fireEvent.change(note, { target: { value: 'Unsaved instructor observation' } });
  fireEvent.change(attendance, { target: { value: 'no_show' } });
  fireEvent.change(cancel, { target: { value: 'Unsaved cancellation reason' } });
  fireEvent.change(title, { target: { value: 'Unsaved class title' } });
  note.focus();
  const requests = getCount('/classes');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(getCount('/classes')).toBe(requests);
  expect(document.activeElement).toBe(note);
  expect(screen.getByText(/Automatic refresh is paused/)).toBeTruthy();
  await refresh();
  expect(getCount('/classes')).toBe(requests + 1);
  expect(screen.getAllByLabelText('Verification note')[0]).toBe(note);
  expect(note.value).toBe('Unsaved instructor observation');
  expect(attendance.value).toBe('no_show');
  expect(cancel.value).toBe('Unsaved cancellation reason');
  expect(title.value).toBe('Unsaved class title');
});

test('pristine visible page refreshes after two minutes; hidden pages do not poll', async () => {
  await mount();
  const requests = getCount('/classes');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(getCount('/classes')).toBe(requests);
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(getCount('/classes')).toBe(requests + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(getCount('/classes')).toBe(requests + 1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(getCount('/classes')).toBe(requests + 2);
});

test('failed save preserves drafts; successful save clears only the saved attendee draft', async () => {
  await mount();
  fireEvent.change(screen.getAllByLabelText('Verification note')[0], { target: { value: 'First observation' } });
  fireEvent.change(screen.getAllByLabelText('Observed attendance')[0], { target: { value: 'no_show' } });
  fireEvent.change(screen.getAllByLabelText('Verification note')[1], { target: { value: 'Second unsaved observation' } });
  failSave = true;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save attendance for First Member' })); });
  expect(screen.getByText('Save failed; retry your attendance.')).toBeTruthy();
  expect((screen.getAllByLabelText('Verification note')[0] as HTMLInputElement).value).toBe('First observation');
  failSave = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save attendance for First Member' })); });
  expect((screen.getAllByLabelText('Verification note')[0] as HTMLInputElement).value).toBe('');
  expect((screen.getAllByLabelText('Observed attendance')[0] as HTMLSelectElement).value).toBe('no_show');
  expect((screen.getAllByLabelText('Verification note')[1] as HTMLInputElement).value).toBe('Second unsaved observation');
  expect(screen.getByText(/Automatic refresh is paused/)).toBeTruthy();
  fireEvent.change(screen.getAllByLabelText('Verification note')[1], { target: { value: '' } });
  expect(screen.queryByText(/Automatic refresh is paused/)).toBeNull();
  const requests = getCount('/classes');
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(getCount('/classes')).toBe(requests + 1);
});

test('attendance drafts belong to their class and survive closing and reopening a roster', async () => {
  await mount();
  fireEvent.change(screen.getAllByLabelText('Verification note')[0], { target: { value: 'Safety 4 draft' } });
  await openRoster(5);
  expect((screen.getAllByLabelText('Verification note')[0] as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getAllByLabelText('Verification note')[0], { target: { value: 'Safety 5 draft' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close roster' })); });
  await openRoster(4);
  expect((screen.getAllByLabelText('Verification note')[0] as HTMLInputElement).value).toBe('Safety 4 draft');
  await openRoster(5);
  expect((screen.getAllByLabelText('Verification note')[0] as HTMLInputElement).value).toBe('Safety 5 draft');
});

test('retained private roster is cleared when a refresh denies access', async () => {
  await mount();
  expect(screen.getByText(/first@example.invalid/)).toBeTruthy();
  denyRoster = true;
  await refresh();
  expect(screen.getByText('Roster access removed.')).toBeTruthy();
  expect(screen.queryByText(/first@example.invalid/)).toBeNull();
  expect(screen.queryByLabelText('Verification note')).toBeNull();
});
