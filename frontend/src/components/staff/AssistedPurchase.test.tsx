// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../lib/api';
import { AssistedPurchase } from './AssistedPurchase';
const { api, state, useApi } = vi.hoisted(() => ({ api: vi.fn(), state: { enabled: true, mode: 'test', refreshing: false }, useApi: vi.fn() }));
vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, actor: null }) }));
vi.mock('../../lib/useApi', () => ({ useApi }));
// The quote on screen stays put while a new date is re-priced (refreshing), as useApi's retainOnChange keeps it.
useApi.mockImplementation(() => ({ data: { enabled: state.enabled, mode: state.mode, offers: [
 { id: 7, name: 'Monthly', kind: 'membership', months: 1, revision: 4, pricingRevision: 2, amountCents: 4000, price: '50.00', active: true },
 { id: 8, name: 'Day pass', kind: 'day_pass', revision: 3, pricingRevision: 1, amountCents: 1500, price: '15.00', active: true },
 { id: 9, name: 'Approved free monthly', kind: 'membership', months: 1, revision: 1, pricingRevision: 6, amountCents: 0, price: '50.00', active: true },
 ] }, loading: false, refreshing: state.refreshing, error: '', reload: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); state.enabled = true; state.mode = 'test'; state.refreshing = false; });
const props = { id: 42, plans: [], timeZone: 'America/New_York', renewal: null, disabled: false, onSaved: vi.fn() };
test('card purchase sends member-specific quote and explicit renewal consent, and surfaces checkout errors', async () => {
 api.mockRejectedValueOnce(new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Stripe temporarily unavailable'));
 render(<AssistedPurchase {...props} />);
 fireEvent.change(screen.getByLabelText('Plan to purchase'), { target: { value: '7' } });
 const consent = screen.getByRole('checkbox'); expect((consent as HTMLInputElement).required).toBe(true);
 fireEvent.click(consent);
 fireEvent.submit(screen.getByRole('form'));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Stripe temporarily unavailable');
 expect(api).toHaveBeenCalledWith('/admin/users/42/purchase', { method: 'POST', body: {
  planId: 7, expectedRevision: 4, pricingRevision: 2, amountCents: 4000, validDate: undefined, autoRenewConsent: true, freeMembership: false,
 } });
 expect(props.onSaved).not.toHaveBeenCalled();
});
test('staff see the test-card notice only when Stripe is in test mode', () => {
 render(<AssistedPurchase {...props} />);
 expect(screen.getByText(/Stripe is currently in test mode/)).toBeTruthy();
 cleanup(); state.mode = 'live';
 render(<AssistedPurchase {...props} />);
 expect(screen.getByText(/Access is issued only after Stripe confirms payment/)).toBeTruthy();
 expect(screen.queryByText(/test mode|test card/)).toBeNull();
});
test('a monthly card plan tells staff its rate is fixed for the life of the subscription', () => {
 render(<AssistedPurchase {...props} />);
 fireEvent.change(screen.getByLabelText('Plan to purchase'), { target: { value: '7' } });
 expect(screen.getByText(/rate stays the same for as long as this subscription runs/)).toBeTruthy();
 expect(screen.queryByText(/Future rates depend/)).toBeNull();
});
test('day pass sends chosen visit date without subscription consent', async () => {
 api.mockRejectedValueOnce(new Error('Checkout unavailable')); render(<AssistedPurchase {...props} />);
 fireEvent.change(screen.getByLabelText('Plan to purchase'), { target: { value: '8' } });
 expect(screen.queryByRole('checkbox')).toBeNull();
 fireEvent.change(screen.getByLabelText('Pass valid date (America/New_York)'), { target: { value: '2030-01-02' } });
 fireEvent.submit(screen.getByRole('form')); await screen.findByRole('alert');
 expect(api).toHaveBeenCalledWith('/admin/users/42/purchase', expect.objectContaining({ body: expect.objectContaining({ planId: 8, validDate: '2030-01-02', autoRenewConsent: false }) }));
});
test('approved free access refreshes records after server verification', async () => {
 api.mockResolvedValueOnce({ issued: true }); render(<AssistedPurchase {...props} />);
 fireEvent.change(screen.getByLabelText('Plan to purchase'), { target: { value: '9' } });
 fireEvent.click(screen.getByRole('button', { name: 'Issue approved free access' }));
 await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
 expect(api).toHaveBeenCalledWith('/admin/users/42/purchase', expect.objectContaining({ body: expect.objectContaining({ freeMembership: true, amountCents: 0 }) }));
});
test('unconfigured Stripe starts on recording an outside payment, offering only collected or waived payments', () => {
 state.enabled = false; render(<AssistedPurchase {...props} />);
 // Card checkout can't be used here, so staff land on the form that works.
 expect((screen.getByLabelText('How will the member pay?') as HTMLSelectElement).value).toBe('external');
 expect(screen.queryByRole('button', { name: 'Continue to Stripe' })).toBeNull();
 expect(screen.getByText(/Card checkout isn’t set up here/)).toBeTruthy();
 expect(screen.queryByRole('option', { name: 'Pending' })).toBeNull();
 expect(screen.getByRole('option', { name: 'Paid externally' })).toBeTruthy();
 expect(screen.getByRole('option', { name: 'Waived (zero amount)' })).toBeTruthy();
});

test('staff can select a plan before checkout becomes available', async () => {
 const user = userEvent.setup();
 api.mockRejectedValueOnce(new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Stripe temporarily unavailable'));
 render(<AssistedPurchase {...props} />);
 const select = screen.getByLabelText('Plan to purchase');
 const submit = screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement;
 expect((select.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
 expect(submit.disabled).toBe(true);
 await user.selectOptions(select, '8');
 expect((select as HTMLSelectElement).value).toBe('8');
 expect(submit.disabled).toBe(false);
 await user.click(submit);
 await screen.findByRole('alert');
 expect(api).toHaveBeenCalledWith('/admin/users/42/purchase', expect.objectContaining({ body: expect.objectContaining({ planId: 8 }) }));
});

test('a new pass date keeps the date field in place, and only complete dates are re-priced', () => {
 render(<AssistedPurchase {...props} />);
 expect(useApi.mock.calls[0]![1]).toMatchObject({ retainOnChange: true });
 fireEvent.change(screen.getByLabelText('Plan to purchase'), { target: { value: '8' } });
 const field = screen.getByLabelText('Pass valid date (America/New_York)') as HTMLInputElement;
 const submit = screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement;
 field.focus();
 const quoted = () => useApi.mock.lastCall![0];

 state.refreshing = true;
 fireEvent.change(field, { target: { value: '2031-05-06' } });
 expect(quoted()).toBe('/admin/users/42/purchase?date=2031-05-06');
 // Re-pricing doesn't remove or disable the field being typed in, but the old price can't be submitted.
 expect(screen.getByLabelText('Pass valid date (America/New_York)')).toBe(field);
 expect(document.activeElement).toBe(field);
 expect((field.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
 expect(submit.disabled).toBe(true);
 state.refreshing = false;

 // Typing a year digit by digit passes through dates the server can't price; keep the last quote.
 fireEvent.change(field, { target: { value: '0002-05-06' } });
 expect(quoted()).toBe('/admin/users/42/purchase?date=2031-05-06');
 expect(screen.getByLabelText('Pass valid date (America/New_York)')).toBe(field);
 expect(submit.disabled).toBe(true);
 fireEvent.change(field, { target: { value: '2032-05-06' } });
 expect(quoted()).toBe('/admin/users/42/purchase?date=2032-05-06');
 expect(submit.disabled).toBe(false);
});
