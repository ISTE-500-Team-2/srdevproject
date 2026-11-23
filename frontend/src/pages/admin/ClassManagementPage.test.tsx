// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClassManagementPage } from './ClassManagementPage';
import { api } from '../../lib/api';
import { mockApi } from '../../testing/apiMock';
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: vi.fn() }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, roles: ['admin'] } }) }));
const item = { id: 3, title: 'Resin workshop', description: 'Make a platter', capacity: 12, image: '/assets/resin-platter.webp', revision: 2 };
beforeEach(() => { mockApi(async (path, options) => {
  if (options?.method) return { ...item, ...(options.body as object) };
  if (path === '/classes/catalog') return [item];
  if (path === '/classes') return [{ ...item, catalogId: 3, certificationId: null, certificationName: 'Creative workshop', instructorId: 1, instructor: 'Teacher', roomName: 'Studio', roomId: 1, enrolled: 4, status: 'scheduled', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString(), myStatus: null }];
  return [];
}); });
afterEach(cleanup);
const mount = () => render(<MemoryRouter><ClassManagementPage /></MemoryRouter>);
test('staff add a reusable class with title, description, image and roster limit', async () => {
  mount(); await screen.findByRole('heading', { name: item.title });
  fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
  fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Glass art' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Build framed glass art' } });
  fireEvent.change(screen.getByLabelText(/Roster size/), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resin and glass art' }));
  fireEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]') ?? screen.getAllByRole('button', { name: 'Add class' }).at(-1)!);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/classes/catalog', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ title: 'Glass art', description: 'Build framed glass art', capacity: 8, image: '/assets/resin-glass-art.webp' }) })));
});
test('catalog edits carry the original revision', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit Resin workshop' }));
  fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Updated workshop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/classes/catalog/3', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ title: 'Updated workshop', expectedRevision: 2 }) })));
});
test('upcoming sessions have a details editor with enrollment-aware roster size', async () => {
  mount(); fireEvent.click(screen.getByRole('tab', { name: 'Scheduled sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Resin workshop' }));
  expect(screen.getByLabelText(/Roster size/).getAttribute('min')).toBe('4');
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated session' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/classes/3', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ description: 'Updated session', expectedRevision: 2 }) })));
});

test('removing a catalog class requires confirmation and carries its revision', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit Resin workshop' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove class' }));
  expect(screen.getByText(/Existing sessions, rosters and attendance history stay available/)).toBeTruthy();
  expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/classes/catalog/3', expect.objectContaining({ method: 'DELETE', body: { expectedRevision: 2 } })));
  expect(await screen.findByText('Class removed from catalog.')).toBeTruthy();
});
test('switching management tabs preserves the schedule search and does not refetch classes', async () => {
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Scheduled sessions' }));
  const search = await screen.findByRole('searchbox', { name: 'Search classes' });
  fireEvent.change(search, { target: { value: 'Resin' } });
  const reads = () => vi.mocked(api).mock.calls.filter(([path]) => path === '/classes').length;
  const before = reads();
  fireEvent.click(screen.getByRole('tab', { name: 'Class catalog' }));
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Class catalog' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Scheduled sessions' }).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByRole('searchbox', { name: 'Search classes' }) as HTMLInputElement).value).toBe('Resin');
  expect(reads()).toBe(before);
});
