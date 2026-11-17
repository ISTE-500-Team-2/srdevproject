// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EquipmentManagementPage } from './EquipmentManagementPage';
import type { EquipmentBooking, EquipmentDetail } from '../../lib/equipmentMaintenance';
const { api, ApiError } = vi.hoisted(() => ({
  api: vi.fn(),
  ApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
}));
vi.mock('../../lib/api', () => ({ api, ApiError, errorMessage: (e: Error) => e.message }));

const machine: EquipmentDetail = { id: 1, name: 'Phoebe', type: '3D printer', location: 'Print lab', certification: null, certId: null, waiverRequired: false, rate: 12, image: '/machine.webp', imagePath: null, status: 'maintenance', availabilityRevision: 2, outage: null,
  history: [], activeGrants: [], checkedAt: new Date().toISOString(), timeZone: 'America/New_York', canManage: true, canReadBookings: true, canManageBookings: true };
const future = Date.now() + 3 * 86400000;
const booking = (id: number, extra: Partial<EquipmentBooking> = {}): EquipmentBooking => ({ id, userId: 7, equipmentId: 1, equipmentName: 'Phoebe', memberName: `Member ${id}`, location: 'Print lab',
  startTime: new Date(future + id * 3600000).toISOString(), endTime: new Date(future + (id + 1) * 3600000).toISOString(), status: 'confirmed', revision: 1, isClass: false, payerId: null, paymentStatus: null, ...extra });
let bookings: EquipmentBooking[];
const bookingReads = () => api.mock.calls.filter(([path]) => String(path).startsWith('/admin/equipment/1/bookings?')).length;
beforeEach(() => {
  bookings = [booking(1), booking(2, { payerId: 7, paymentStatus: 'paid' }), booking(3, { payerId: 7, paymentStatus: 'pending', status: 'pending', holdUntil: new Date(future).toISOString() })];
  api.mockImplementation((path: string) => {
    if (path === '/admin/equipment/1') return Promise.resolve(structuredClone(machine));
    if (path.startsWith('/admin/equipment/1/bookings?')) return Promise.resolve({ items: structuredClone(bookings), nextOffset: null });
    return Promise.resolve({});
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mount = () => render(<MemoryRouter initialEntries={['/admin/equipment/1']}><Routes><Route path="/admin/equipment/:equipmentId?" element={<EquipmentManagementPage />} /></Routes></MemoryRouter>);
const row = async (member: string) => (await screen.findByText(member)).closest('article')!;

test('online-paid bookings cannot be moved, and a booking awaiting online payment cannot be cancelled yet', async () => {
  mount();
  const plain = await row('Member 1');
  expect((within(plain).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(false);
  expect((within(plain).getByRole('button', { name: 'Cancel booking' }) as HTMLButtonElement).disabled).toBe(false);
  const paid = await row('Member 2');
  const move = within(paid).getByRole('button', { name: 'Move' }) as HTMLButtonElement;
  expect(move.disabled).toBe(true);
  expect((within(paid).getByRole('button', { name: 'Cancel booking' }) as HTMLButtonElement).disabled).toBe(false);
  expect(document.getElementById(move.getAttribute('aria-describedby')!)!.textContent).toMatch(/Paid online, so it can’t be moved/);
  const pending = await row('Member 3');
  expect((within(pending).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(pending).getByRole('button', { name: 'Cancel booking' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(pending).getByText(/Waiting for the member’s online payment, so it can’t be changed yet\. The hold is released at/)).toBeTruthy();
});

test('the bookings list refreshes on its own and picks up bookings made elsewhere', async () => {
  mount();
  await row('Member 1');
  const reads = bookingReads();
  bookings.push(booking(4));
  // The same check the 15-second timer runs; it fires on window focus too.
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Member 4')).toBeTruthy();
  expect(bookingReads()).toBeGreaterThan(reads);
});

test('a booking changed elsewhere reloads the list and says to choose it again', async () => {
  mount();
  fireEvent.click(within(await row('Member 1')).getByRole('button', { name: 'Cancel booking' }));
  const dialog = await screen.findByRole('dialog');
  const reads = bookingReads();
  api.mockImplementationOnce(() => Promise.reject(new ApiError(409, 'STALE_RECORD', 'This reservation changed. Refresh it before cancelling.')));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));
  expect((await within(dialog).findByRole('alert')).textContent).toMatch(/changed after the list was loaded\. The list is now up to date/);
  await waitFor(() => expect(bookingReads()).toBeGreaterThan(reads));
  expect((within(dialog).getByRole('button', { name: 'Confirm cancellation' }) as HTMLButtonElement).disabled).toBe(true);
});

test('after cancelling a booking, keyboard focus moves to the confirmation', async () => {
  mount();
  const cancel = within(await row('Member 1')).getByRole('button', { name: 'Cancel booking' });
  cancel.focus();
  fireEvent.click(cancel);
  const dialog = await screen.findByRole('dialog');
  bookings = bookings.slice(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const message = screen.getByText(/Booking cancelled\./).closest('p')!;
  expect(document.activeElement).toBe(message);
  expect(message.tabIndex).toBe(-1);
});

test('saving an availability change moves focus to the confirmation instead of losing it', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Return to service' }));
  const save = screen.getByRole('button', { name: 'Return to service' });
  save.focus();
  fireEvent.click(save);
  const message = (await screen.findByText(/Phoebe is available again/)).closest('p')!;
  await waitFor(() => expect(document.activeElement).toBe(message));
});
