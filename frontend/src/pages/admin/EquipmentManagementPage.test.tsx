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
  machine = { id: 1, name: 'Phoebe', type: '3D printer', location: 'Print lab', certification: null, rate: 12, image: '/machine.webp', status: 'available', availabilityRevision: 1, outage: null,
    history: [], activeGrants: [], checkedAt: new Date().toISOString(), timeZone: 'America/New_York', canManage: true, canReadBookings: true, canManageBookings: true };
  api.mockImplementation((path: string) => {
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
