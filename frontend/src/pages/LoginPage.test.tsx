// @vitest-environment jsdom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LoginPage } from './LoginPage';

const auth = vi.hoisted(() => ({ register: vi.fn(), loading: false }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
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
  type(within(dialog).getByLabelText('Date of birth'), '2000-01-01');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  type(await within(dialog).findByLabelText('Email'), 'casey@example.invalid');
  type(within(dialog).getByLabelText('Phone'), '0000000000');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  type(await within(dialog).findByLabelText('Username'), 'casey_demo');
  type(within(dialog).getByLabelText('Password', { exact: false }), 'ValidPassword!');
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
});

function ResetLocation() {
  const location = useLocation();
  return <output data-testid="reset-location">{JSON.stringify({ path: location.pathname, email: location.state?.email })}</output>;
}
test.each([' member@example.invalid ', 'member_username'])('Forgot password routes publicly and only carries emails: %s', identifier => {
  render(<MemoryRouter><LoginPage /><ResetLocation /></MemoryRouter>);
  type(screen.getByLabelText('Email or username'), identifier);
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect(JSON.parse(screen.getByTestId('reset-location').textContent!)).toEqual({
    path: '/reset-password', ...(identifier.includes('@') ? { email: identifier.trim() } : {}),
  });
  expect(screen.queryByRole('dialog', { name: 'Reset your password' })).toBeNull();
});
