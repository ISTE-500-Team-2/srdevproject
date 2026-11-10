// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Header } from './Header';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { firstName: 'Casey', lastName: 'Demo', email: 'casey@example.invalid', roles: ['member'] }, logout: vi.fn() }),
}));

beforeEach(() => {
  // Reduced motion: jsdom cannot run CardNav's Web Animations intro.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mobileNav = () => screen.getByRole('navigation', { name: 'Mobile navigation' });

test('the phone menu has the appearance switch, since the desktop header is hidden below 1040px', async () => {
  render(<MemoryRouter><Header /></MemoryRouter>);
  const nav = mobileNav();
  const dark = within(nav).getByRole('radio', { name: 'Dark', hidden: true });
  // Closed menu: the switch is out of the tab order.
  expect(dark.closest('[inert]')).not.toBeNull();

  await userEvent.click(within(nav).getByRole('button', { name: /menu/i }));
  expect(dark.closest('[inert]')).toBeNull();
  await userEvent.click(within(nav).getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
});
