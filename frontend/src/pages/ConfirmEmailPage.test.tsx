// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ConfirmEmailPage } from './ConfirmEmailPage';
const { confirmEmail, api } = vi.hoisted(() => ({ confirmEmail: vi.fn(), api: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ confirmEmail }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function mount() { render(<MemoryRouter initialEntries={['/confirm-email#test-token']}><Routes><Route path="/confirm-email" element={<ConfirmEmailPage />} /><Route path="/" element={<h1>Dashboard</h1>} /></Routes></MemoryRouter>); }
test('email link shows only confirmation and opens dashboard after success', async () => {
  confirmEmail.mockResolvedValue('member'); mount();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText('Need another email?')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
  await screen.findByRole('heading', { name: 'Dashboard' });
  expect(confirmEmail).toHaveBeenCalledWith('test-token');
});
test('failure offers recovery without showing forms on the token landing', async () => {
  confirmEmail.mockRejectedValue(new Error('Expired link')); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByRole('link', { name: 'Request a new confirmation email' }).getAttribute('href')).toBe('/confirm-email');
  // A link opened again after it already worked: the way on is to sign in.
  expect(screen.getByText(/Already confirmed\?/)).toBeTruthy();
  expect(screen.getByText('Sign in').getAttribute('href')).toBe('/login');
  expect(screen.queryByRole('textbox')).toBeNull();
});
function Location() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.hash}</output>
    <button type="button" onClick={() => navigate('/confirm-email#pasted-token')}>Paste link</button></>;
}
test('a confirmation link pasted into the waiting tab is captured and stripped', async () => {
  confirmEmail.mockResolvedValue('member');
  render(<MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: { email: 'test@example.test' } }]}><Location /><Routes><Route path="/confirm-email" element={<ConfirmEmailPage />} /><Route path="/" element={<h1>Dashboard</h1>} /></Routes></MemoryRouter>);
  expect(screen.getByText('Confirmation sent')).toBeTruthy();
  fireEvent.click(screen.getByText('Paste link'));
  expect(await screen.findByText('Confirm your email')).toBeTruthy();
  expect(screen.getByTestId('location').textContent).toBe('/confirm-email');
  fireEvent.click(screen.getByText('Confirm email'));
  await screen.findByRole('heading', { name: 'Dashboard' });
  expect(confirmEmail).toHaveBeenCalledWith('pasted-token');
});
test('a corrected resend keeps both addresses, so a retry after a mistyped password still reaches the sign-up', async () => {
  // The answer is the same whether or not anything moved, so the page cannot assume the correction took.
  api.mockResolvedValue({ message: 'Queued.' });
  render(<MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: { email: 'typo@example.test' } }]}><ConfirmEmailPage /></MemoryRouter>);
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  fireEvent.change(field('Password'), { target: { value: 'Mistyped!' } });
  fireEvent.change(field('Corrected email (optional)'), { target: { value: 'right@example.test' } });
  const send = screen.getByText('Send confirmation email');
  fireEvent.click(send);
  await screen.findByText('Queued.');
  expect(api).toHaveBeenLastCalledWith('/auth/confirmation', { method: 'POST', body: { email: 'typo@example.test', password: 'Mistyped!', newEmail: 'right@example.test' } });
  expect(field('Signup email').value).toBe('typo@example.test');
  expect(field('Corrected email (optional)').value).toBe('right@example.test');
  fireEvent.change(field('Password'), { target: { value: 'ValidPassword!' } });
  fireEvent.click(send);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api).toHaveBeenLastCalledWith('/auth/confirmation', { method: 'POST', body: { email: 'typo@example.test', password: 'ValidPassword!', newEmail: 'right@example.test' } });
});
test('disabled local email is explicit without restoring the old recovery form', () => {
  render(<MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: { email: 'test@example.test', emailSendingEnabled: false } }]}><ConfirmEmailPage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Email unavailable' })).toBeTruthy();
  // Disabled email delivery leaves only a temporary request, never an active member account.
  expect(screen.getByRole('status').textContent).toContain('no member account has been created');
  expect(screen.queryByRole('heading', { name: 'Confirmation sent' })).toBeNull();
  expect(screen.getByText('Didn’t get the email?').closest('details')?.open).toBe(false);
});
test('arriving from the login page opens the resend form with the email filled in', () => {
  render(<MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: { email: 'casey@example.invalid', resend: true } }]}><ConfirmEmailPage /></MemoryRouter>);
  // Nothing was sent just now, so the page doesn't say it was.
  expect(screen.getByRole('heading', { name: 'Check your email' })).toBeTruthy();
  expect(screen.getByText('Didn’t get the email?').closest('details')?.open).toBe(true);
  expect((screen.getByLabelText('Signup email') as HTMLInputElement).value).toBe('casey@example.invalid');
  expect(document.activeElement).toBe(screen.getByLabelText('Password'));
});
