// @vitest-environment jsdom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { LoginPage } from './LoginPage';

const auth = vi.hoisted(() => ({ register: vi.fn(), login: vi.fn(), loading: false }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    login: auth.login,
    loginAs: vi.fn(),
    register: auth.register,
    demoLogin: false,
    loading: auth.loading,
  }),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.animate ??= function () {
    const animation = { cancel() {}, onfinish: null as null | (() => void) };
    setTimeout(() => animation.onfinish?.(), 0);
    return animation as unknown as Animation;
  };
  Element.prototype.getAnimations ??= () => [];
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.loading = false;
});

function openSignup() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
  return screen.getByRole('dialog', { name: 'Create your account' });
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

async function fillToLastStep(dialog: HTMLElement) {
  type(within(dialog).getByLabelText('First name'), 'Casey');
  type(within(dialog).getByLabelText('Last name'), 'Demo');
  // Native date-picker input must survive the step transition before the browser commits a change event.
  fireEvent.input(within(dialog).getByLabelText('Date of birth'), { target: { value: '2000-01-01' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  type(await within(dialog).findByLabelText('Email'), 'casey@example.invalid');
  type(within(dialog).getByLabelText('Phone'), '0000000000');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  // New sign-ups require only a password at the final step, with no username field.
  expect(within(dialog).queryByLabelText('Username')).toBeNull();
  type(await within(dialog).findByLabelText('Password', { exact: false }), 'ValidPassword!');
}

test('steps advance while the session check is still loading; only creating waits', async () => {
  auth.loading = true;
  const dialog = openSignup();
  await fillToLastStep(dialog);
  const create = within(dialog).getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.keyDown(within(dialog).getByLabelText('Password', { exact: false }), { key: 'Enter' });
  expect(auth.register).not.toHaveBeenCalled();
});

test('Enter while a registration is pending does not register again', async () => {
  auth.register.mockReturnValue(new Promise(() => {}));
  const dialog = openSignup();
  await fillToLastStep(dialog);
  const password = within(dialog).getByLabelText('Password', { exact: false });
  fireEvent.keyDown(password, { key: 'Enter' });
  fireEvent.keyDown(password, { key: 'Enter' });
  await waitFor(() =>
    expect((within(dialog).getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true),
  );
  fireEvent.keyDown(password, { key: 'Enter' });
  expect(auth.register).toHaveBeenCalledTimes(1);
  // Public requests must not carry a username even though legacy login still accepts one.
  expect(auth.register.mock.calls[0]![0]).not.toHaveProperty('username');
  expect(auth.register.mock.calls[0]![0].dob).toBe('2000-01-01');
});

function ResetLocation() {
  const location = useLocation();
  return <output data-testid="reset-location">{JSON.stringify({ path: location.pathname, email: location.state?.email })}</output>;
}
test.each([' member@example.invalid ', 'invalid-email'])('Forgot password routes publicly and only carries emails: %s', email => {
  render(<MemoryRouter><LoginPage /><ResetLocation /></MemoryRouter>);
  type(screen.getByLabelText('Email'), email);
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect(JSON.parse(screen.getByTestId('reset-location').textContent!)).toEqual({
    path: '/reset-password', ...(email.includes('@') ? { email: email.trim() } : {}),
  });
  expect(screen.queryByRole('dialog', { name: 'Reset your password' })).toBeNull();
});

function signIn(path = '/login') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}
function Landed() {
  const { pathname, search } = useLocation();
  return <p>Landed on {pathname + search}</p>;
}
const emailField = () => screen.getByPlaceholderText('Enter your email…');
const passwordField = () => screen.getByPlaceholderText('Enter your password…');
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Login' }));

test('Remember me starts unchecked for shared computers', () => {
  signIn();
  expect(screen.getByRole('checkbox', { name: 'Remember me' }).getAttribute('aria-checked')).toBe('false');
});

test('signing in returns to the page that required it', async () => {
  auth.login.mockResolvedValue('member');
  signIn('/login?next=%2Fmembership%3Fplan%3D2');
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'ValidPassword!');
  submit();
  await screen.findByText('Landed on /membership?plan=2');
  expect(auth.login).toHaveBeenCalledWith('casey@example.invalid', 'ValidPassword!', false);
});

test('a next link to another site lands on home instead', async () => {
  auth.login.mockResolvedValue('member');
  signIn('/login?next=%2F%2Fevil.example%2Fphish');
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'ValidPassword!');
  submit();
  await screen.findByText('Landed on /');
});

test('missing fields are marked invalid, described by the error, and focused', () => {
  signIn();
  submit();
  const alert = screen.getByRole('alert');
  expect(alert.id).toBe('login-error');
  expect(emailField().getAttribute('aria-invalid')).toBe('true');
  expect(emailField().getAttribute('aria-describedby')).toBe('login-error');
  expect(passwordField().getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(emailField());
  type(emailField(), 'casey@example.invalid');
  expect(emailField().getAttribute('aria-invalid')).toBeNull();
  submit();
  expect(document.activeElement).toBe(passwordField());
  expect(emailField().getAttribute('aria-invalid')).toBeNull();
  expect(auth.login).not.toHaveBeenCalled();
});

test('wrong credentials mark both fields and move focus to the password', async () => {
  auth.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'));
  signIn();
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'wrong');
  submit();
  await screen.findByText('Email or password is incorrect.');
  expect(emailField().getAttribute('aria-invalid')).toBe('true');
  expect(passwordField().getAttribute('aria-describedby')).toBe('login-error');
  await waitFor(() => expect(document.activeElement).toBe(passwordField()));
});

test('errors that are not about the fields leave them unmarked', async () => {
  auth.login.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.'));
  signIn();
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'whatever');
  submit();
  await screen.findByText('Too many attempts. Try again later.');
  expect(emailField().getAttribute('aria-invalid')).toBeNull();
  expect(passwordField().getAttribute('aria-invalid')).toBeNull();
});
