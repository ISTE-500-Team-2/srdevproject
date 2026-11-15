// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../lib/api';
import type { UserProfile } from '../lib/contracts';
import { SignInSection } from './ProfileSignIn';

const { api, refresh, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  auth: {
    user: { id: 42, firstName: 'Test', lastName: 'Member', email: 'test@example.com', phone: '', role: 'member', roles: ['member'], membership: 'None' },
    actor: null as null | { id: number },
  },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, actor: auth.actor, refresh }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));

const baseProfile = {
  user: auth.user,
  address: {},
  contactPreferences: {},
  studioContact: { name: 'Studio', email: 's@example.com', phone: null },
  passwordChangedAt: '2026-10-02T15:00:00Z',
  pendingEmail: null,
} as unknown as UserProfile;
let onProfile = vi.fn<(change: Partial<UserProfile>) => void>();
let notify = vi.fn<(message: string) => void>();
const mount = (profile: UserProfile = baseProfile) =>
  render(<SignInSection profile={profile} onProfile={onProfile} notify={notify} />);
const section = () => screen.getByRole('region', { name: 'Sign-in' });
const fill = (label: string, value: string) => fireEvent.change(within(section()).getByLabelText(label), { target: { value } });

beforeEach(() => {
  auth.actor = null;
  onProfile = vi.fn<(change: Partial<UserProfile>) => void>();
  notify = vi.fn<(message: string) => void>();
  refresh.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('shows the sign-in email and when the password last changed', () => {
  mount();
  expect(within(section()).getByText('test@example.com')).toBeTruthy();
  expect(within(section()).getByText(/^Last changed .*2026$/)).toBeTruthy();
  expect(within(section()).getByRole('button', { name: 'Change email' })).toBeTruthy();
  expect(within(section()).getByRole('button', { name: 'Change password' })).toBeTruthy();
});

test('a new password is checked before sending, then this browser stays signed in', async () => {
  api.mockResolvedValue({ accessToken: 'fresh', csrfToken: 'csrf' });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  fill('Current password', 'OldPassword1!');
  fill('New password', 'weakpassword');
  fill('Repeat new password', 'weakpassword');
  fireEvent.click(within(section()).getByRole('button', { name: 'Change password' }));
  expect((await within(section()).findByRole('alert')).textContent).toBe('Include an uppercase letter.');
  fill('New password', 'BrandNew-Password1');
  fireEvent.click(within(section()).getByRole('button', { name: 'Change password' }));
  expect((await within(section()).findByRole('alert')).textContent).toBe('The new passwords don’t match.');
  expect(api).not.toHaveBeenCalled();

  fill('Repeat new password', 'BrandNew-Password1');
  fireEvent.click(within(section()).getByRole('button', { name: 'Change password' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Password changed. Your other devices are signed out.'));
  expect(api).toHaveBeenCalledWith('/me/password', { method: 'POST', body: { currentPassword: 'OldPassword1!', newPassword: 'BrandNew-Password1' } });
  expect(refresh).toHaveBeenCalledWith(false, { fresh: true });
  expect(onProfile).toHaveBeenCalledWith({ passwordChangedAt: expect.any(String), pendingEmail: null });
});

test('a wrong current password is said plainly and the form stays open', async () => {
  api.mockRejectedValue(new ApiError(400, 'CURRENT_PASSWORD_INVALID', 'Your current password is incorrect.', 'currentPassword'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  fill('Current password', 'nope');
  fill('New password', 'BrandNew-Password1');
  fill('Repeat new password', 'BrandNew-Password1');
  fireEvent.click(within(section()).getByRole('button', { name: 'Change password' }));
  expect((await within(section()).findByRole('alert')).textContent).toBe('Your current password is incorrect.');
  expect(within(section()).getByLabelText('Current password')).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

test('asking for a new email sends a link and shows it waiting', async () => {
  const pendingEmail = { email: 'new@example.com', expiresAt: '2026-11-16T20:00:00Z' };
  api.mockResolvedValue({ pendingEmail, emailSendingEnabled: true });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  fill('New email', ' new@example.com ');
  fill('Current password', 'OldPassword1!');
  fireEvent.click(within(section()).getByRole('button', { name: 'Send confirmation link' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Check new@example.com for a confirmation link.'));
  expect(api).toHaveBeenCalledWith('/me/email-change', { method: 'POST', body: { email: 'new@example.com', currentPassword: 'OldPassword1!' } });
  expect(onProfile).toHaveBeenCalledWith({ pendingEmail });
});

test('a waiting change can be sent again or cancelled', async () => {
  const pendingEmail = { email: 'new@example.com', expiresAt: '2026-11-16T20:00:00Z' };
  api.mockImplementation((path: string, init?: { method?: string }) =>
    Promise.resolve(init?.method === 'DELETE' ? { pendingEmail: null } : { pendingEmail, emailSendingEnabled: true }));
  mount({ ...baseProfile, pendingEmail });
  expect(within(section()).getByRole('status').textContent).toMatch(/Check new@example.com for a confirmation link/);
  expect(within(section()).getByText('test@example.com')).toBeTruthy(); // still the sign-in email

  fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Link sent again to new@example.com.'));
  expect(api).toHaveBeenCalledWith('/me/email-change/resend', { method: 'POST' });

  fireEvent.click(screen.getByRole('button', { name: 'Cancel the change' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Email change cancelled.'));
  expect(api).toHaveBeenCalledWith('/me/email-change', { method: 'DELETE' });
  expect(onProfile).toHaveBeenLastCalledWith({ pendingEmail: null });
});

test("staff in a member's account see the details but no changes", () => {
  auth.actor = { id: 7 };
  mount();
  expect(within(section()).getByText('Members change their own email and password.')).toBeTruthy();
  expect(within(section()).queryByRole('button')).toBeNull();
});

test('changes wait until the profile has loaded, so what they return has somewhere to go', () => {
  render(<SignInSection profile={null} onProfile={onProfile} notify={notify} />);
  expect(within(section()).getByText('test@example.com')).toBeTruthy();
  expect(within(section()).queryByRole('button')).toBeNull();
});
