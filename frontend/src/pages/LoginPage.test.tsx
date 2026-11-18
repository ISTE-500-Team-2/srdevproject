// @vitest-environment jsdom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { LoginPage } from './LoginPage';

const auth = vi.hoisted(() => ({ register: vi.fn(), login: vi.fn(), loading: false }));
const { preloadForSignIn, prepareArrival } = vi.hoisted(() => ({ preloadForSignIn: vi.fn(), prepareArrival: vi.fn(async () => {}) }));
vi.mock('../areas/load', () => ({ preloadForSignIn, prepareArrival }));
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

test('signup refuses a password over 72 bytes before asking the server', async () => {
  const dialog = openSignup();
  await fillToLastStep(dialog);
  const password = within(dialog).getByLabelText('Password', { exact: false }) as HTMLInputElement;
  expect(password.maxLength).toBe(72);
  expect(within(dialog).getByText(/8–72 characters/).textContent).toContain('Accented letters and emoji count as more than one.');
  // 39 characters, 76 bytes: short enough for maxLength, too long for bcrypt.
  type(password, 'A!' + 'é'.repeat(37));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
  expect(password.validationMessage).toContain('at most 72 characters');
  expect(auth.register).not.toHaveBeenCalled();
  auth.register.mockReturnValue(new Promise(() => {}));
  type(password, 'ValidPassword!');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(auth.register).toHaveBeenCalledTimes(1));
});

// The visible step, by the first field it shows.
const stepShown = (dialog: HTMLElement) =>
  within(dialog).queryByLabelText('First name') ? 1
    : within(dialog).queryByLabelText('Email') ? 2
      : within(dialog).queryByLabelText('Password', { exact: false }) ? 3 : null;

test.each([
  // The server's field decides, whatever the wording says.
  ['firstName', 'Check this detail.', 1],
  ['dob', 'Check your email address.', 1],
  ['email', 'That one is already taken.', 2],
  ['phone', 'Choose a stronger password.', 2],
  ['password', 'Enter your first name.', 3],
  // A request field no step holds keeps the visitor on the last step.
  ['timeZone', 'Enter your email.', 3],
  // Without a field, the wording still picks the step.
  [undefined, 'Enter your email.', 2],
  [undefined, 'Enter your date of birth.', 1],
  [undefined, 'Something went wrong.', 3],
])('a signup error naming field %s with "%s" returns to step %i', async (field, message, step) => {
  auth.register.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', message, field));
  const dialog = openSignup();
  await fillToLastStep(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
  await within(dialog).findByText(message);
  await waitFor(() => expect(stepShown(dialog)).toBe(step));
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

test('missing fields are marked invalid, described by the error, and focused', async () => {
  signIn();
  // What a screen reader reads on focus: the field must already be marked invalid.
  const atFocus: (string | null)[] = [];
  emailField().addEventListener('focus', () => atFocus.push(emailField().getAttribute('aria-invalid')));
  submit();
  await waitFor(() => expect(document.activeElement).toBe(emailField()));
  expect(atFocus).toEqual(['true']);
  const alert = screen.getByRole('alert');
  expect(alert.id).toBe('login-error');
  expect(emailField().getAttribute('aria-invalid')).toBe('true');
  expect(emailField().getAttribute('aria-describedby')).toBe('login-error');
  expect(passwordField().getAttribute('aria-invalid')).toBe('true');
  type(emailField(), 'casey@example.invalid');
  expect(emailField().getAttribute('aria-invalid')).toBeNull();
  submit();
  await waitFor(() => expect(document.activeElement).toBe(passwordField()));
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

test('starting to sign in begins downloading the member site', () => {
  preloadForSignIn.mockClear();
  signIn();
  fireEvent.focus(emailField());
  expect(preloadForSignIn).toHaveBeenCalled();
});

test('submitting starts the member download before the password check finishes', async () => {
  preloadForSignIn.mockClear();
  let finish!: (role: string) => void;
  auth.login.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  signIn();
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'ValidPassword!');
  preloadForSignIn.mockClear();
  fireEvent.submit(emailField().closest('form')!);
  expect(preloadForSignIn).toHaveBeenCalled();
  finish('member');
});

test('a sign-in that finishes after leaving the login page does not pull the visitor away', async () => {
  let finish!: (role: string) => void;
  auth.login.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  signIn('/login?next=%2Fmembership');
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'ValidPassword!');
  fireEvent.submit(emailField().closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect((await screen.findByText(/^Landed on/)).textContent).toBe('Landed on /reset-password');
  await act(async () => { finish('member'); await new Promise((r) => setTimeout(r, 0)); });
  expect(screen.getByText(/^Landed on/).textContent).toBe('Landed on /reset-password');
});

function ConfirmLocation() {
  const location = useLocation();
  return <output data-testid="confirm-location">{JSON.stringify({ path: location.pathname, state: location.state })}</output>;
}
test('an unconfirmed account is offered a new confirmation email, carrying the typed email', async () => {
  auth.login.mockRejectedValue(new ApiError(403, 'EMAIL_CONFIRMATION_REQUIRED', 'Confirm your email before signing in.'));
  render(<MemoryRouter><LoginPage /><ConfirmLocation /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Resend confirmation email' })).toBeNull();
  type(emailField(), ' casey@example.invalid ');
  type(passwordField(), 'ValidPassword!');
  submit();
  await screen.findByText('Confirm your email before signing in.');
  fireEvent.click(screen.getByRole('button', { name: 'Resend confirmation email' }));
  expect(JSON.parse(screen.getByTestId('confirm-location').textContent!)).toEqual({
    path: '/confirm-email', state: { email: 'casey@example.invalid', resend: true },
  });
});

test('other sign-in errors offer no confirmation email', async () => {
  auth.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'));
  signIn();
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'wrong');
  submit();
  await screen.findByText('Email or password is incorrect.');
  expect(screen.queryByRole('button', { name: 'Resend confirmation email' })).toBeNull();
});

test('a sign-in error stays on the login card and a sign-up error stays in the dialog', async () => {
  auth.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'));
  signIn();
  type(emailField(), 'casey@example.invalid');
  type(passwordField(), 'wrong');
  submit();
  await screen.findByText('Email or password is incorrect.');
  fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
  const dialog = screen.getByRole('dialog', { name: 'Create your account' });
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(within(dialog).queryByText('Email or password is incorrect.')).toBeNull();

  auth.register.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Choose a stronger password.', 'password'));
  await fillToLastStep(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
  await within(dialog).findByText('Choose a stronger password.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create your account' })).toBeNull());
  expect(screen.queryByText('Choose a stronger password.')).toBeNull();
  // The login card's own error is still the sign-in one.
  expect(screen.getByRole('alert').textContent).toBe('Email or password is incorrect.');
});

async function toContactStep(dialog: HTMLElement) {
  type(within(dialog).getByLabelText('First name'), 'Casey');
  type(within(dialog).getByLabelText('Last name'), 'Demo');
  fireEvent.input(within(dialog).getByLabelText('Date of birth'), { target: { value: '2000-01-01' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  type(await within(dialog).findByLabelText('Email'), 'casey@example.invalid');
}

test('a pasted, formatted phone number fits and is saved as digits', async () => {
  auth.register.mockReturnValue(new Promise(() => {}));
  const dialog = openSignup();
  await toContactStep(dialog);
  const phone = within(dialog).getByLabelText('Phone') as HTMLInputElement;
  expect(phone.maxLength).toBeGreaterThanOrEqual('+1 (410) 555-0182'.length);
  type(phone, '+1 (410) 555-0182');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  type(await within(dialog).findByLabelText('Password', { exact: false }), 'ValidPassword!');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(auth.register).toHaveBeenCalledTimes(1));
  expect(auth.register.mock.calls[0]![0].phone).toBe('14105550182');
});

test.each(['call me', '555-01', '1234567890123456'])('the contact step refuses the phone number %s', async (value) => {
  const dialog = openSignup();
  await toContactStep(dialog);
  const phone = within(dialog).getByLabelText('Phone') as HTMLInputElement;
  type(phone, value);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  expect(phone.validationMessage).toContain('7 to 15 digits');
  expect(within(dialog).queryByLabelText('Password', { exact: false })).toBeNull();
});

test('date of birth runs from 1900 to today where the visitor is, so a future year stops step one', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 9pm on New Year's Eve in New York is already January 1 in UTC.
  vi.setSystemTime(new Date(2030, 11, 31, 21, 0));
  try {
    const dialog = openSignup();
    const dob = within(dialog).getByLabelText('Date of birth') as HTMLInputElement;
    expect(dob.min).toBe('1900-01-01');
    expect(dob.max).toBe('2030-12-31');
    type(within(dialog).getByLabelText('First name'), 'Casey');
    type(within(dialog).getByLabelText('Last name'), 'Demo');
    fireEvent.input(dob, { target: { value: '2062-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(dob.validity.rangeOverflow).toBe(true);
    expect(within(dialog).getByLabelText('Date of birth')).toBe(dob);
  } finally {
    vi.useRealTimers();
  }
});
