// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EquipmentManagementPage } from './EquipmentManagementPage';
import type { ManagedEquipment } from '../../lib/equipmentMaintenance';
import type { Reservation } from '../../lib/contracts';
import { dayKey, localHour } from '../../lib/today';

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
let yesterdayBookings: Reservation[];
const ZONE = 'America/New_York';
const todayKey = () => dayKey(Date.now(), ZONE);
const yesterdayKey = () => { const d = new Date(`${todayKey()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
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
  yesterdayBookings = [];
  api.mockImplementation((path: string) => {
    if (path === '/admin/equipment') return Promise.resolve(structuredClone(machines));
    if (path === '/config') return Promise.resolve({ timeZone: 'America/New_York' });
    if (path === `/admin/reservations?date=${yesterdayKey()}`) return Promise.resolve({ items: structuredClone(yesterdayBookings), nextOffset: null });
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

test('unreadable bookings are reported as unknown, never as a free day', async () => {
  bookings = new Error('Reservation read permission is required.');
  mount();
  expect(await screen.findByText(/Today’s bookings could not be loaded\. Reservation read permission is required\./)).toBeTruthy();
  // Reader and maintenance state do not depend on bookings.
  expect((await row('Rachel')).textContent).toContain('In use');
  expect((await row('Spock')).textContent).toContain('Out of service');
  const kirk = await row('Kirk');
  expect(kirk.textContent).toMatch(/Not in use.*Bookings unavailable/);
  expect(kirk.textContent).not.toMatch(/Available|Nothing/);
  expect(within(kirk).getByRole('img').getAttribute('aria-label')).toBe('Today’s bookings are unavailable');
  const booked = screen.getByRole('button', { name: /Booked today/ }) as HTMLButtonElement;
  expect(booked.disabled).toBe(true);
  expect(booked.textContent).toContain('–');
});

test('a booking that began yesterday still counts while it runs into today', async () => {
  const midnight = localHour(todayKey(), 0, ZONE);
  const overnight = booking(21, 5, 0, 0, 'Morgan Diaz');
  overnight.startTime = new Date(midnight - 2 * HOUR).toISOString(); overnight.endTime = new Date(Date.now() + HOUR).toISOString();
  const finished = booking(22, 1, 0, 0, 'Riley Chen');
  finished.startTime = new Date(midnight - 3 * HOUR).toISOString(); finished.endTime = new Date(midnight - HOUR).toISOString();
  // The same booking can arrive in both lists; it is shown once.
  yesterdayBookings = [overnight, finished, (bookings as Reservation[])[1]];
  mount();
  await waitFor(async () => expect((await row('Kirk')).textContent).toMatch(/Booked until .*Morgan Diaz/));
  expect((await row('Rachel')).textContent).not.toContain('Riley Chen');
  expect(screen.getByRole('button', { name: /3\s*Booked today/ })).toBeTruthy();
});

test('“Booked today” keeps machines whose bookings have finished', async () => {
  bookings = [booking(31, 5, -0.05, 0.01, 'Sam Lee')];
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: /1\s*Booked today/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Booked today/ }));
  expect(screen.getAllByRole('link').map(l => l.textContent)).toEqual([expect.stringMatching(/^Kirk/)]);
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
  expect(await within(panel).findByText('Nothing booked today.')).toBeTruthy();
  fireEvent.click(await row('Darth Vader'));
  const next = await screen.findByRole('complementary', { name: 'Darth Vader details' });
  expect(await within(next).findByText('Priya Shah')).toBeTruthy();
  expect((await row('Darth Vader')).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('heading', { level: 1, name: 'Equipment' })).toBeTruthy();
  // The availability action opens the machine page with its form already open.
  fireEvent.click(await within(next).findByRole('link', { name: 'Take out of service' }));
  expect(await screen.findByRole('button', { name: 'Confirm out of service' })).toBeTruthy();
});
