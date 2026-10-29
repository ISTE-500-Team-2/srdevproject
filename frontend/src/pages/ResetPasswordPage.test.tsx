// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { ResetPasswordPage } from './ResetPasswordPage';

vi.mock('../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/api')>(), api: vi.fn() }));
vi.mock('../components/reactbits/SplitText', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock('../components/reactbits/ClickSpark', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const call = vi.mocked(api);
const token = 'a'.repeat(43);
function Location() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.hash}</output>
    <button type="button" onClick={() => navigate(`/reset-password#${token}`)}>Open emailed link in this tab</button></>;
}
function mount(hash = '', email?: string, strict = false) {
  const app = <MemoryRouter initialEntries={[{ pathname: '/reset-password', hash, state: email ? { email } : undefined }]}>
    <Location /><Routes><Route path="/reset-password" element={<ResetPasswordPage />} /><Route path="/login" element={<h1>Login</h1>} /></Routes>
  </MemoryRouter>;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
}
const type = (placeholder: string, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const send = () => { type('Enter your account email…', 'casey@example.invalid'); click('Send reset link'); };
async function resetForm() {
  call.mockResolvedValue(undefined);
  mount(`#${token}`);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save password' }) as HTMLButtonElement).disabled).toBe(false));
}
const validPasswords = () => { type('Create a password…', 'Workshop!'); type('Type it again…', 'Workshop!'); };
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

test('request starts at step one without moving focus on first load, including StrictMode', () => {
  mount('', 'prefilled@example.invalid', true);
  expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Step 1 of 3' })).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('prefilled@example.invalid');
});
test('empty and malformed submissions have associated alerts and never call the API; typing clears them', () => {
  mount(); click('Send reset link');
  expect(screen.getByRole('alert').textContent).toBe('Enter the email on your account.');
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe('reset-email-error');
  type('Enter your account email…', 'bad'); expect(screen.queryByRole('alert')).toBeNull();
  click('Send reset link'); expect(screen.getByRole('alert').textContent).toBe('That doesn’t look like an email address.');
  expect(call).not.toHaveBeenCalled();
});
test('valid request waits for the API then shows neutral copy, emphasized email, focus and a 60-second cooldown', async () => {
  let finish!: () => void;
  call.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mount(); send();
  expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish());
  expect(call).toHaveBeenCalledWith('/auth/password-reset', { method: 'POST', body: { email: 'casey@example.invalid' } });
  expect(screen.getByText('casey@example.invalid').className).toBe('reset-email');
  expect(screen.getByText(/If an account uses/).textContent).toContain('a reset link is on its way');
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Check your email' }));
  expect((screen.getByRole('button', { name: 'Resend link in 1:00' }) as HTMLButtonElement).disabled).toBe(true);
});
test('resend unlocks after 60 seconds and calls the API again before restarting the countdown', async () => {
  vi.useFakeTimers(); call.mockResolvedValue(undefined); mount();
  await act(async () => send());
  act(() => vi.advanceTimersByTime(59000));
  expect((screen.getByRole('button', { name: 'Resend link in 0:01' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => vi.advanceTimersByTime(1000));
  expect((screen.getByRole('button', { name: 'Resend link' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => click('Resend link'));
  expect(call).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Resend link in 1:00' })).toBeTruthy();
});
test('request and resend failures show the server message without pretending a send succeeded', async () => {
  call.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Wait before trying again.'));
  mount(); send();
  expect((await screen.findByRole('alert')).textContent).toBe('Wait before trying again.');
  expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
  vi.useFakeTimers(); call.mockResolvedValueOnce(undefined);
  await act(async () => click('Send reset link'));
  act(() => vi.advanceTimersByTime(60000));
  call.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Please try again.'));
  await act(async () => click('Resend link'));
  expect(screen.getByRole('alert').textContent).toBe('Please try again.');
  click('use a different email'); expect(screen.queryByRole('alert')).toBeNull();
});
test('fragment is stripped with replacement while a token check keeps the complete reset view disabled', async () => {
  let finish!: () => void;
  call.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mount(`#${token}`);
  expect(screen.getByTestId('location').textContent).toBe('/reset-password');
  expect(call).toHaveBeenCalledWith('/auth/password-reset/check', expect.objectContaining({ method: 'POST', body: { token } }));
  expect(screen.getByRole('list', { name: 'Step 3 of 3' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Checking link…' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole('button', { name: 'Checking link…' }).closest('form')!);
  expect(call).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Save password' })).toBeTruthy();
});
test('malformed and rejected links show expiry and offer a fresh request', async () => {
  mount('#bad'); expect(screen.getByRole('heading', { name: 'Link expired' })).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
  click('Send a new link'); expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
  cleanup(); call.mockRejectedValueOnce(new ApiError(400, 'RESET_INVALID', 'Invalid link')); mount(`#${token}`);
  expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeTruthy();
});
test('a throttled or failed link check keeps the reset form and explains instead of claiming expiry', async () => {
  call.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many password reset attempts.')); mount(`#${token}`);
  expect((await screen.findByRole('alert')).textContent).toBe('Too many password reset attempts.');
  expect(screen.getByRole('heading', { name: 'New password' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Link expired' })).toBeNull();
  call.mockResolvedValueOnce(undefined); validPasswords(); click('Save password');
  expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeTruthy();
  expect(call).toHaveBeenLastCalledWith('/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'Workshop!' } });
});
test('rules tick live and one eye button reveals and hides both passwords', async () => {
  await resetForm(); type('Create a password…', 'Workshop!');
  const rules = screen.getByText('Passwords match').closest('ul')!;
  expect(rules.querySelectorAll('[data-met]')).toHaveLength(3);
  expect(rules.getAttribute('aria-live')).toBe('polite');
  type('Type it again…', 'Workshop!'); expect(rules.querySelectorAll('[data-met]')).toHaveLength(4);
  expect(within(rules).getAllByText('(met)')).toHaveLength(4);
  click('Show password');
  expect(screen.getByPlaceholderText('Create a password…').getAttribute('type')).toBe('text');
  expect(screen.getByPlaceholderText('Type it again…').getAttribute('type')).toBe('text');
  click('Hide password'); expect(screen.getByPlaceholderText('Type it again…').getAttribute('type')).toBe('password');
});
test('unmet rules or mismatched passwords prevent confirmation', async () => {
  await resetForm(); click('Save password');
  expect(screen.getByRole('alert').textContent).toBe('Your password doesn’t meet every requirement yet.');
  type('Create a password…', 'Workshop!'); type('Type it again…', 'Different!'); click('Save password');
  expect(call).toHaveBeenCalledTimes(1);
});
test('confirmation succeeds only after saving, clears fields, focuses completion, then navigates to login', async () => {
  await resetForm(); validPasswords(); click('Save password');
  const done = await screen.findByRole('heading', { name: 'You’re all set' });
  expect(call).toHaveBeenLastCalledWith('/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'Workshop!' } });
  expect(document.activeElement).toBe(done);
  expect(screen.queryByPlaceholderText('Create a password…')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
  click('Go to login'); expect(screen.getByRole('heading', { name: 'Login' })).toBeTruthy();
});
test('expired-on-confirm links go to recovery; hashing length errors remain visible on the form', async () => {
  await resetForm(); validPasswords();
  call.mockRejectedValueOnce(new ApiError(400, 'PASSWORD_TOO_LONG', 'Passwords must be at most 72 UTF-8 bytes.'));
  click('Save password'); expect((await screen.findByRole('alert')).textContent).toContain('72 UTF-8 bytes');
  call.mockRejectedValueOnce(new ApiError(400, 'RESET_INVALID', 'Invalid link')); click('Save password');
  expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeTruthy();
  click('Send a new link'); expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an emailed fragment opened in the same tab is captured, checked and stripped, including reuse after success', async () => {
  call.mockResolvedValue(undefined); mount(); send();
  await screen.findByRole('heading', { name: 'Check your email' });
  click('Open emailed link in this tab');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save password' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByTestId('location').textContent).toBe('/reset-password');
  expect(call).toHaveBeenLastCalledWith('/auth/password-reset/check', expect.objectContaining({ body: { token } }));
  validPasswords(); click('Save password'); await screen.findByRole('heading', { name: 'You’re all set' });
  call.mockRejectedValueOnce(new ApiError(400, 'RESET_INVALID', 'Invalid link'));
  click('Open emailed link in this tab');
  expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeTruthy();
});

test('a late email-request response cannot replace a newly opened reset form', async () => {
  let finish!: () => void;
  call.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mount(); send(); call.mockResolvedValue(undefined); click('Open emailed link in this tab');
  await screen.findByRole('button', { name: 'Save password' });
  await act(async () => finish());
  expect(screen.getByRole('heading', { name: 'New password' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
});

test('reopening a consumed fragment rechecks even when browser history retains the same router key', async () => {
  window.history.replaceState({ idx: 0, key: 'retained' }, '', `/reset-password#${token}`);
  call.mockResolvedValue(undefined);
  render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);
  await screen.findByRole('button', { name: 'Save password' });
  validPasswords(); click('Save password'); await screen.findByRole('heading', { name: 'You’re all set' });
  call.mockRejectedValueOnce(new ApiError(400, 'RESET_INVALID', 'Invalid link'));
  act(() => {
    window.history.pushState({ idx: 1, key: 'retained' }, '', `/reset-password#${token}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
  expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeTruthy();
  expect(window.location.hash).toBe('');
});
