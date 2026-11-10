// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EquipmentManagementPage } from './EquipmentManagementPage';
import type { ManagedEquipment } from '../../lib/equipmentMaintenance';
import type { Reservation } from '../../lib/contracts';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../lib/api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));

const HOUR = 3600000;
const machine = (id: number, name: string, extra: Partial<ManagedEquipment> = {}): ManagedEquipment => ({
  id, name, type: 'Laser engraver', location: 'Makerspace', certification: null, rate: 15, image: '/m.webp', status: 'available', availabilityRevision: 1, outage: null, activeReaderLeases: 0, ...extra,
});
const booking = (id: number, equipmentId: number, fromNow: number, hours: number, memberName: string): Reservation => ({
  id, userId: id, equipmentId, equipmentName: '', resourceType: 'equipment', location: 'Makerspace', status: 'confirmed', revision: 1, memberName,
  startTime: new Date(Date.now() + fromNow * HOUR).toISOString(), endTime: new Date(Date.now() + (fromNow + hours) * HOUR).toISOString(),
});

let machines: ManagedEquipment[];
let bookings: Reservation[] | Error;
let observedWidth = 0;
beforeEach(() => {
  observedWidth = 0;
  machines = [
    machine(1, 'Rachel', { activeReaderLeases: 1 }),
    machine(2, 'Darth Vader', { certification: 'Laser safety' }),
    machine(3, 'Spock', { status: 'maintenance', outage: { id: 9, reason: 'repair', staffNote: '', expectedBack: '2099-03-14', startedAt: new Date(Date.now() - 26 * HOUR).toISOString(), startedBy: 'Alex', endedAt: null, endedBy: null, returnNote: null } }),
    machine(4, 'Ross'),
    machine(5, 'Kirk'),
  ];
  // Kept within an hour of now so the test does not straddle midnight in practice.
  bookings = [booking(11, 2, 0.5, 1, 'Priya Shah'), booking(12, 4, -0.25, 0.75, 'Jordan Ortiz')];
  api.mockImplementation((path: string) => {
    if (path === '/admin/equipment') return Promise.resolve(structuredClone(machines));
    if (path === '/config') return Promise.resolve({ timeZone: 'America/New_York' });
    if (path.startsWith('/admin/reservations?')) return bookings instanceof Error ? Promise.reject(bookings) : Promise.resolve({ items: structuredClone(bookings), nextOffset: null });
    if (path.includes('/bookings')) return Promise.resolve({ items: [], nextOffset: null });
    const detail = path.match(/^\/admin\/equipment\/(\d+)$/);
    if (detail) return Promise.resolve({ ...machines.find(m => m.id === Number(detail[1])), history: [], activeGrants: [], checkedAt: new Date().toISOString(), timeZone: 'America/New_York', canManage: true, canReadBookings: true, canManageBookings: true });
    return Promise.resolve({});
  });
  // jsdom has no layout: report whatever width the test asks for.
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: observedWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const mount = () => render(<MemoryRouter initialEntries={['/admin/equipment']}><Routes><Route path="/admin/equipment/:equipmentId?" element={<EquipmentManagementPage />} /></Routes></MemoryRouter>);
const row = async (name: string) => (await screen.findByRole('link', { name: new RegExp(`^${name}`) }));

test('each machine says what it is doing now and what comes next', async () => {
  mount();
  expect((await row('Rachel')).textContent).toContain('In use');
  expect((await row('Rachel')).textContent).toContain('Reader session active');
  await waitFor(async () => expect((await row('Darth Vader')).textContent).toMatch(/Next: Priya S\. at \d/));
  expect((await row('Darth Vader')).textContent).toContain('Laser safety');
  expect((await row('Spock')).textContent).toMatch(/Out of service.*Repair · back/);
  expect((await row('Ross')).textContent).toMatch(/Booked until .*Jordan Ortiz/);
  expect((await row('Kirk')).textContent).toContain('Nothing else booked today');
  expect(within(await row('Darth Vader')).getByRole('img').getAttribute('aria-label')).toMatch(/Priya Shah, .* to /);
});

test('the counts double as filters', async () => {
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: /2\s*Booked today/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /1\s*In use/ }));
  expect(screen.getAllByRole('link').map(l => l.textContent)).toEqual([expect.stringMatching(/^Rachel/)]);
  fireEvent.click(screen.getByRole('button', { name: /1\s*Out of service/ }));
  expect(screen.getAllByRole('link').map(l => l.textContent)).toEqual([expect.stringMatching(/^Spock/)]);
  fireEvent.click(screen.getByRole('button', { name: /2\s*Booked today/ }));
  expect(screen.getAllByRole('link')).toHaveLength(2);
});

test('the list still works when today’s bookings cannot be read', async () => {
  bookings = new Error('Reservation read permission is required.');
  mount();
  expect(await screen.findByText(/Today’s bookings could not be loaded\. Reservation read permission is required\./)).toBeTruthy();
  expect((await row('Rachel')).textContent).toContain('In use');
  expect((await row('Kirk')).textContent).toContain('Available');
});

test('below the split width a row opens the machine page', async () => {
  mount();
  expect((await row('Kirk')).getAttribute('href')).toBe('/admin/equipment/5');
  expect(screen.queryByRole('complementary')).toBeNull();
});

test('on a wide screen a row opens beside the list instead of leaving it', async () => {
  observedWidth = 1600;
  mount();
  const panel = await screen.findByRole('complementary', { name: 'Rachel details' });
  expect(within(panel).getByText('Nothing booked today.')).toBeTruthy();
  fireEvent.click(await row('Darth Vader'));
  const next = await screen.findByRole('complementary', { name: 'Darth Vader details' });
  expect(within(next).getByText('Priya Shah')).toBeTruthy();
  expect((await row('Darth Vader')).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('heading', { level: 1, name: 'Equipment' })).toBeTruthy();
  // The availability action opens the machine page with its form already open.
  fireEvent.click(await within(next).findByRole('link', { name: 'Take out of service' }));
  expect(await screen.findByRole('button', { name: 'Confirm out of service' })).toBeTruthy();
});
