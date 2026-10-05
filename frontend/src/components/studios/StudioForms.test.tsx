// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StudioConfig } from './StudioConfig';
import { StaffRental } from './StaffRental';
import { AvailabilityCalendar } from './AvailabilityCalendar';
import type { Studio, Rental } from '../../lib/studioContracts';
afterEach(cleanup);
const studio: Studio = { id: 3, name: 'Paris', size: 'Large', monthly_cents: 120000, cancellation_policy: 'no_refunds', policy_confirmed: true, revision: 7, availability: [] };
const rental: Rental = { id: 8, name: 'Paris', starts_on: '2030-01-01', ends_on: '2030-02-01', amount_cents: 120000, status: 'pending', payment_status: 'pending', payment_method: 'manual', hold_until: '2030-01-01T12:00:00Z', refund_cents: 120000, cancellation_policy: 'no_refunds' };

test('studio configuration preserves edited values on rerender and sends the existing revision contract', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const view = render(<StudioConfig studio={studio} busy={false} save={save} />);
  const button = screen.getByRole('button', { name: 'Save studio terms' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Monthly rate (USD)'), { target: { value: '975.25' } });
  fireEvent.change(screen.getByLabelText('Cancellation policy'), { target: { value: 'full_before_start' } });
  fireEvent.click(screen.getByRole('checkbox'));
  view.rerender(<StudioConfig studio={{ ...studio }} busy={false} save={save} />);
  expect((screen.getByLabelText('Monthly rate (USD)') as HTMLInputElement).value).toBe('975.25');
  fireEvent.submit(button.closest('form')!);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ monthlyCents: 97525, cancellationPolicy: 'full_before_start', policyConfirmed: true, revision: 7 }));
});

test('manual rental payment and refund controls retain their routes and references', async () => {
  const perform = vi.fn().mockResolvedValue(undefined);
  const view = render(<StaffRental rental={rental} busy={false} perform={perform} />);
  fireEvent.change(screen.getByLabelText('Receipt/reference for payment received'), { target: { value: 'receipt-8' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Record received payment' }).closest('form')!);
  expect(perform).toHaveBeenCalledWith('/studio-management/rentals/8/payment', { reference: 'receipt-8' });
  view.rerender(<StaffRental rental={{ ...rental, status: 'cancelled', payment_status: 'refund_pending' }} busy={false} perform={perform} />);
  fireEvent.change(screen.getByLabelText('Original-method refund reference'), { target: { value: 'refund-8' } });
  fireEvent.submit(screen.getByRole('button', { name: /Record completed/ }).closest('form')!);
  expect(perform).toHaveBeenCalledWith('/studio-management/rentals/8/refund', { reference: 'refund-8' });
});

test('card refund retry keeps its reconciliation route and busy restriction', () => {
  const perform = vi.fn();
  const props = { rental: { ...rental, payment_method: 'stripe_test', payment_status: 'refund_failed', refund_id: 're_8' }, busy: true, perform };
  const view = render(<StaffRental {...props} />);
  const button = screen.getByRole('button', { name: 'Recheck refund after Stripe reconciliation' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<StaffRental {...props} busy={false} />);
  fireEvent.click(button);
  expect(perform).toHaveBeenCalledWith('/studio-management/rentals/8/retry-refund', {});
});

test('calendar distinguishes holds/bookings and treats the rental end as exclusive', () => {
  const onSelect = vi.fn();
  const occupied = { ...studio, availability: [
    { starts_on: '2030-02-01', ends_on: '2030-02-03', status: 'pending', hold_until: '' },
    { starts_on: '2030-02-03', ends_on: '2030-02-04', status: 'confirmed', hold_until: '' },
  ] };
  render(<AvailabilityCalendar studios={[occupied]} selectedStart="2030-02-04" onSelect={onSelect} />);
  fireEvent.change(screen.getByLabelText('Calendar month'), { target: { value: '2030-02' } });
  expect(screen.getByTitle('Paris 2030-02-01: pending').textContent).toBe('H');
  expect(screen.getByTitle('Paris 2030-02-03: confirmed').textContent).toBe('B');
  expect(screen.queryByRole('button', { name: 'Select 2030-02-02 for Paris' })).toBeNull();
  const available = screen.getByRole('button', { name: 'Select 2030-02-04 for Paris' });
  expect(available.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(available);
  expect(onSelect).toHaveBeenCalledWith('2030-02-04');
  expect(screen.getAllByRole('columnheader')).toHaveLength(29);
});
