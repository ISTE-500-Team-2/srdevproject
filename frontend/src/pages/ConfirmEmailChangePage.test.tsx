// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { ConfirmEmailChangePage } from './ConfirmEmailChangePage';

const { api, refresh, auth } = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), auth: { user: null as null | { id: number } } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, refresh }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));

const token = 'A'.repeat(43);
const open = (hash: string) =>
  render(
    <MemoryRouter initialEntries={[`/confirm-email-change${hash}`]}>
      <Routes>
        <Route path="/confirm-email-change" element={<ConfirmEmailChangePage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  auth.user = null;
  refresh.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('nothing changes until the member clicks, then the new email is confirmed', async () => {
  api.mockResolvedValue({ email: 'new@example.com' });
  open(`#${token}`);
  expect(screen.getByRole('heading', { name: 'Confirm your new email' })).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
  expect(await screen.findByRole('heading', { name: 'Email changed' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/You now sign in with new@example.com/);
  expect(api).toHaveBeenCalledWith('/auth/email-change/confirm', { method: 'POST', body: { token } });
  // Signed out here: the way on is to sign in with the new address.
  expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

test('a signed-in member goes back to their profile with the session updated', async () => {
  auth.user = { id: 42 };
  api.mockResolvedValue({ email: 'new@example.com' });
  open(`#${token}`);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
  expect(await screen.findByRole('link', { name: 'Go to your profile' })).toBeTruthy();
  expect(refresh).toHaveBeenCalledWith(false, { fresh: true });
});

test('an expired or broken link says so and offers the profile', async () => {
  api.mockRejectedValue(new ApiError(400, 'EMAIL_CHANGE_INVALID', 'This link is invalid or has expired. Your email hasn’t changed.'));
  open(`#${token}`);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/invalid or has expired/);
  cleanup();
  open('#not-a-token');
  expect(screen.queryByRole('button', { name: 'Confirm new email' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/link is incomplete/);
});
