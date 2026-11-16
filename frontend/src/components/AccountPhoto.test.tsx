// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { forgetPhotos } from '../lib/profilePhoto';
import { AccountPhoto } from './AccountPhoto';

const { api, auth } = vi.hoisted(() => ({ api: vi.fn(), auth: { user: { id: 1 } as { id: number } | null } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  forgetPhotos();
});

const staff = { id: 2, firstName: 'Sam', lastName: 'Staff', photoVersion: 'staff-photo' };

// The workspace sidebar shows the staff member while a member's account may still be open.
test("a staff avatar waits for the session to show the staff member's own account", async () => {
  auth.user = { id: 1 };
  api.mockResolvedValue({ version: 'staff-photo', image: 'data:image/webp;base64,U1RBRkY=' });
  const { container, rerender } = render(<AccountPhoto person={staff} className="admin-avatar" />);
  expect(screen.getByText('SS')).toBeTruthy();
  expect(api).not.toHaveBeenCalled();

  auth.user = { id: 2 };
  rerender(<AccountPhoto person={staff} className="admin-avatar" />);
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,U1RBRkY='));
  expect(container.firstElementChild?.className).toBe('admin-avatar has-photo');
  expect(api).toHaveBeenCalledTimes(1);
});

test('people without a photo, and signed-out pages, show initials without asking', () => {
  auth.user = { id: 2 };
  render(<AccountPhoto person={{ ...staff, photoVersion: null }} className="admin-avatar" />);
  auth.user = null;
  render(<AccountPhoto person={staff} className="admin-avatar" />);
  expect(screen.getAllByText('SS')).toHaveLength(2);
  expect(api).not.toHaveBeenCalled();
});
