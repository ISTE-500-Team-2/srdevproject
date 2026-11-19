// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EquipmentManagementPage } from './EquipmentManagementPage';
import type { EquipmentDetail } from '../../lib/equipmentMaintenance';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../lib/api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));
let machine: EquipmentDetail;
beforeEach(() => {
  machine = { id: 1, name: 'Phoebe', type: '3D printer', location: 'Print lab', certification: null, certId: null, waiverRequired: false, rate: 12, image: '/machine.webp', imagePath: null, status: 'available', availabilityRevision: 1, outage: null, hidden: false,
    history: [], activeGrants: [], checkedAt: new Date().toISOString(), timeZone: 'America/New_York', canManage: true, canReadBookings: true, canManageBookings: true };
  api.mockImplementation((path: string) => {
    if (path === '/admin/equipment/catalog-options') return Promise.resolve({ canManage: machine.canManage, categories: ['Laser', '3D printer'], certifications: [{ id: 3, name: 'Laser safety', state: 'now', holders: 4 }],
      groups: [{ name: '3D printer', machines: [{ id: 1, name: 'Phoebe', image: '/machine.webp' }] }, { name: 'Laser', machines: [{ id: 2, name: 'Darth Vader', image: '/laser.webp' }] }] });
    if (path === '/admin/equipment/1') return Promise.resolve(structuredClone(machine));
    if (path === '/admin/equipment') return Promise.resolve([structuredClone(machine)]);
    if (path.includes('/bookings')) return Promise.resolve({ items: [], nextOffset: null });
    return Promise.resolve({});
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mount = (path = '/admin/equipment/1') => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/equipment/:equipmentId?" element={<EquipmentManagementPage />} /></Routes></MemoryRouter>);
test('Equipment list links to a permanent machine detail', async () => {
  mount('/admin/equipment');
  expect((await screen.findByRole('link', { name: /Phoebe/ })).getAttribute('href')).toBe('/admin/equipment/1');
  fireEvent.click(screen.getByRole('link', { name: /Phoebe/ }));
  expect(await screen.findByRole('heading', { name: 'Phoebe' })).toBeTruthy();
});
test('admins can add equipment from the board and edit rates in the equipment window', async () => {
  mount('/admin/equipment');
  fireEvent.click(await screen.findByRole('button', { name: 'Add equipment' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add equipment' });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'New laser' } });
  const category = within(dialog).getByRole('combobox', { name: 'Category' });
  fireEvent.focus(category); fireEvent.change(category, { target: { value: 'las' } });
  fireEvent.click(await screen.findByRole('option', { name: /^Laser/ }));
  fireEvent.change(within(dialog).getByLabelText('Hourly rate in dollars'), { target: { value: '18.50' } });
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Required certification' }));
  fireEvent.click(await screen.findByRole('option', { name: /^Laser safety/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add equipment' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ name: 'New laser', type: 'Laser', rate: 18.5, certId: 3 }) })));
  cleanup(); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser safety' });
  fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '22.25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  // Phoebe shows the stock picture; an edit must not save that placeholder as her image.
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ rate: 22.25, image: '', waiverRequired: false, expectedRevision: 1 }) })));
});
test('removal lists what is in the way and stays locked until it is resolved', async () => {
  let blockers = { sessions: [] as unknown[], bookings: [{ id: 41, member: 'Jordan Rivera', startTime: '2026-11-14T19:00:00Z', endTime: '2026-11-14T21:00:00Z' }] };
  const base = api.getMockImplementation()!;
  api.mockImplementation((path: string, options?: unknown) => path === '/admin/equipment/1/removal-blockers' ? Promise.resolve(structuredClone(blockers)) : base(path, options));
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser safety' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove equipment' }));
  expect(await screen.findByText('Resolve this first')).toBeTruthy();
  expect(screen.getByText(/Nov 14, 2026, 2:00 PM · Jordan Rivera/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Open bookings/ }).getAttribute('href')).toBe('/admin/reservations?equipmentId=1');
  expect((screen.getByRole('button', { name: 'Confirm removal' }) as HTMLButtonElement).disabled).toBe(true);
  // Once cleared, a server refusal (a booking made meanwhile) keeps the window open and reloads the list.
  fireEvent.click(screen.getByRole('button', { name: 'Keep equipment' }));
  blockers = { sessions: [], bookings: [] };
  fireEvent.click(screen.getByRole('button', { name: 'Remove equipment' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm removal' }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  expect(screen.queryByText('Resolve this first')).toBeNull();
  expect(api.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  api.mockRejectedValueOnce(new Error('Move or cancel upcoming bookings first.'));
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Move or cancel upcoming bookings first.');
  expect(screen.getByRole('dialog', { name: 'Edit equipment' })).toBeTruthy();
});
test('a new category is typed in place, required, and saved by name', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser' });
  const category = screen.getByRole('combobox', { name: 'Category' }) as HTMLSelectElement;
  expect(category.value).toBe('3D printer');
  expect(screen.queryByLabelText('New category name')).toBeNull();
  fireEvent.change(category, { target: { value: '__new__' } });
  const name = screen.getByLabelText(/New category name/) as HTMLInputElement;
  fireEvent.change(name, { target: { value: '   ' } });
  fireEvent.submit(name.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Type a name for the new category.');
  expect(api.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  fireEvent.change(name, { target: { value: 'Metalworking' } });
  fireEvent.change(category, { target: { value: 'Laser' } });
  expect(screen.queryByLabelText(/New category name/)).toBeNull();
  fireEvent.change(category, { target: { value: '__new__' } });
  expect((screen.getByLabelText(/New category name/) as HTMLInputElement).value).toBe('Metalworking');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ type: 'Metalworking' }) })));
});
test('live-session hold preserves the form draft through failed and successful rechecks', async () => {
  machine.activeGrants = [{ readerId: 'printer', members: ['Jordan'], expiresAt: new Date(Date.now() + 5000).toISOString() }];
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Take out of service' }));
  const save = screen.getByRole('button', { name: 'Confirm out of service' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'repair' } });
  fireEvent.change(screen.getByLabelText(/Staff note/), { target: { value: 'Replace bearing' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(save.disabled).toBe(true);
  api.mockRejectedValueOnce(new Error('Cannot verify active sessions'));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(save.disabled).toBe(true);
  expect((screen.getByLabelText(/Staff note/) as HTMLTextAreaElement).value).toBe('Replace bearing');
  machine.activeGrants = [];
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(save.disabled).toBe(false));
  expect((screen.getByLabelText('Reason') as HTMLSelectElement).value).toBe('repair');
  fireEvent.click(save);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1/outage', { method: 'POST', body: { expectedRevision: 1, reason: 'repair', note: 'Replace bearing', stopped: true, expectedBack: '' } }));
});
test('requires a deliberate reason and readiness confirmation; staff sees no status action', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Take out of service' }));
  const save = screen.getByRole('button', { name: 'Confirm out of service' }) as HTMLButtonElement;
  expect((screen.getByLabelText('Reason') as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
  expect(save.disabled).toBe(true); fireEvent.click(screen.getByRole('checkbox')); expect(save.disabled).toBe(false);
  cleanup(); machine.canManage = false; mount();
  expect(await screen.findByText('An administrator can change equipment availability.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Take out of service' })).toBeNull();
});
test('a past estimate remains out of service and offers a deliberate return', async () => {
  machine.status = 'maintenance'; machine.outage = { id: 1, reason: 'repair', staffNote: 'Private note', expectedBack: '2020-01-01', startedAt: '2019-12-31T10:00:00Z', startedBy: 'Alex', endedAt: null, endedBy: null, returnNote: null };
  mount(); expect(await screen.findByText(/estimated return date has passed/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Out of service' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Return to service' })).toBeTruthy();
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
test('admins hide a machine from members and show it again; staff see no visibility action', async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation((path: string, options?: { method?: string; body?: { hidden: boolean } }) => {
    if (path === '/admin/equipment/1/visibility') {
      machine.hidden = options!.body!.hidden; machine.availabilityRevision += 1;
      return Promise.resolve({ hidden: machine.hidden, availabilityRevision: machine.availabilityRevision });
    }
    return base(path, options);
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Hide from members' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1/visibility', { method: 'POST', body: { hidden: true, expectedRevision: 1 } }));
  expect(await screen.findByText('Phoebe is hidden from members. Existing bookings stay in place.')).toBeTruthy();
  expect(await screen.findByText('Hidden from members')).toBeTruthy();
  expect(screen.getByText('Hidden from members. Staff can still book it.')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Show to members' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1/visibility', { method: 'POST', body: { hidden: false, expectedRevision: 2 } }));
  expect(await screen.findByText('Phoebe is shown to members.')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('Hidden from members')).toBeNull());
  cleanup(); machine.canManage = false; mount();
  await screen.findByRole('heading', { name: 'Phoebe' });
  expect(screen.queryByRole('button', { name: /members$/ })).toBeNull();
});
test('a refused visibility change says why and leaves the machine as it was', async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation((path: string, options?: unknown) => path === '/admin/equipment/1/visibility'
    ? Promise.reject(new Error('Equipment changed. Close this window and reload before trying again.')) : base(path, options));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Hide from members' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Equipment changed. Close this window and reload before trying again.');
  expect(screen.getByRole('button', { name: 'Hide from members' })).toBeTruthy();
});
test('the board marks hidden machines and finds them by searching "hidden"', async () => {
  machine.hidden = true;
  mount('/admin/equipment');
  const row = await screen.findByRole('link', { name: /Phoebe/ });
  expect(within(row).getByText('Hidden')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('Find a machine…'), { target: { value: 'hidden' } });
  expect(screen.getByRole('link', { name: /Phoebe/ })).toBeTruthy();
});
