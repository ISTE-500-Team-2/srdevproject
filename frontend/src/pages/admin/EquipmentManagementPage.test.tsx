// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EquipmentManagementPage } from './EquipmentManagementPage';
import type { EquipmentDetail } from '../../lib/equipmentMaintenance';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../lib/api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));
let machine: EquipmentDetail;
beforeEach(() => {
  machine = { id: 1, name: 'Phoebe', type: '3D printer', location: 'Print lab', certification: null, certId: null, waiverRequired: false, rate: 12, image: '/machine.webp', imagePath: null, status: 'available', availabilityRevision: 1, outage: null,
    history: [], activeGrants: [], checkedAt: new Date().toISOString(), timeZone: 'America/New_York', canManage: true, canReadBookings: true, canManageBookings: true };
  api.mockImplementation((path: string) => {
    if (path === '/admin/equipment/catalog-options') return Promise.resolve({ canManage: machine.canManage, categories: ['Laser', '3D printer'], certifications: [{ id: 3, name: 'Laser safety' }] });
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
  expect(await screen.findByRole('dialog', { name: 'Add equipment' })).toBeTruthy();
  await screen.findByRole('option', { name: 'Laser' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New laser' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Laser' } });
  fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '18.50' } });
  fireEvent.change(screen.getByLabelText('Required certification'), { target: { value: '3' } });
  fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ name: 'New laser', rate: 18.5, certId: 3 }) })));
  cleanup(); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser safety' });
  fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '22.25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  // Phoebe shows the stock picture; an edit must not save that placeholder as her image.
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment/1', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ rate: 22.25, image: '', waiverRequired: false, expectedRevision: 1 }) })));
});
test('removal is inside edit and requires confirmation; server failures keep the window open', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser safety' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove equipment' }));
  expect(api.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  api.mockRejectedValueOnce(new Error('Move or cancel upcoming bookings first.'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Move or cancel upcoming bookings first.');
  expect(screen.getByRole('dialog', { name: 'Edit equipment' })).toBeTruthy();
});
test('category dropdown preserves its selection when toggling the new category field', async () => {
  mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit equipment' }));
  await screen.findByRole('option', { name: 'Laser' });
  const category = screen.getByRole('combobox', { name: 'Category' }) as HTMLSelectElement;
  expect(category.value).toBe('3D printer');
  expect(screen.queryByLabelText('New category name')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'New category' }));
  expect(category.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/New category name/), { target: { value: 'Metalworking' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'New category' }));
  expect(category.disabled).toBe(false);
  expect(category.value).toBe('3D printer');
  expect(screen.queryByLabelText(/New category name/)).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'New category' }));
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
