// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Header } from './Header';

const auth = vi.hoisted(() => ({
  user: { firstName: 'Casey', lastName: 'Demo', email: 'casey@example.invalid', roles: ['member'], membership: 'None' },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, logout: vi.fn() }),
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
  auth.user = { ...auth.user, roles: ['member'], membership: 'None' };
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

const openAccountMenu = async () => {
  render(<MemoryRouter><Header /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
  return within(accountMenu()!).getByRole('link', { name: /^Membership/ });
};
const accountMenu = () => document.querySelector<HTMLElement>('.account-menu__popover');

// CardNav's light preset draws a near-white top edge; inline styles can't be themed from dark.css.
test('the phone menu takes its top-edge highlight and focus ring from the theme', () => {
  render(<MemoryRouter><Header /></MemoryRouter>);
  const menu = mobileNav().closest<HTMLElement>('.card-nav')!;
  expect(menu.style.getPropertyValue('--cn-highlight')).toBe('var(--nav-highlight)');
  // Orange is ~2:1 on the near-white bar; the theme's ring is at least 3:1 in both themes.
  expect(menu.style.getPropertyValue('--cn-ring')).toBe('var(--focus-ring)');
});

test('on desktop, Membership lives in the account menu rather than the top links; phones get it in CardNav', async () => {
  render(<MemoryRouter><Header /></MemoryRouter>);
  const primary = screen.getByRole('navigation', { name: 'Primary navigation' });
  expect(within(primary).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Equipment', 'Studios', 'Certifications & Waivers', 'Classes']);
  // Phones use CardNav (the desktop header is hidden below 1040px), not a toggle inside the header.
  expect(screen.queryByRole('button', { name: /navigation$/ })).toBeNull();
  expect(within(mobileNav()).getByRole('link', { name: 'Membership', hidden: true }).getAttribute('href')).toBe('/membership');
  cleanup();

  const item = await openAccountMenu();
  expect(item.getAttribute('href')).toBe('/membership');
  await userEvent.click(item);
  expect(accountMenu()).toBeNull();
});

test('staff reach their workspace from the desktop header and the phone menu', () => {
  auth.user = { ...auth.user, roles: ['staff'] };
  render(<MemoryRouter><Header /></MemoryRouter>);
  const primary = screen.getByRole('navigation', { name: 'Primary navigation' });
  expect(within(primary).queryByRole('link', { name: 'Staff workspace' })).toBeNull();
  const desktop = document.querySelector<HTMLAnchorElement>('.site-header__admin-link')!;
  expect([desktop.textContent?.trim(), desktop.getAttribute('href')]).toEqual(['Staff workspace', '/admin']);
  expect(within(mobileNav()).getByRole('link', { name: 'Staff workspace', hidden: true }).getAttribute('href')).toBe('/admin');
});

test('the account menu shows where the membership stands', async () => {
  auth.user = { ...auth.user, membership: 'Monthly' };
  expect((await openAccountMenu()).textContent).toContain('Active');
  cleanup();

  auth.user = { ...auth.user, membership: 'None' };
  expect((await openAccountMenu()).textContent).toContain('Join');
  cleanup();

  // Staff without a plan of their own are not invited to join.
  auth.user = { ...auth.user, roles: ['staff'], membership: 'None' };
  const staff = await openAccountMenu();
  expect(staff.querySelector('.status-pill')).toBeNull();
});

test('search is a real dialog: the page behind is inert, Tab stays inside, Escape closes it and focus returns', async () => {
  const user = userEvent.setup();
  const view = render(<MemoryRouter><Header /><button>Page content</button></MemoryRouter>);
  const trigger = screen.getByRole('button', { name: 'Search' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Site search' });
  const input = within(dialog).getByRole('textbox', { name: 'Search pages' });
  expect(document.activeElement).toBe(input);
  expect(view.container.inert).toBe(true);
  for (let i = 0; i < 4; i++) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.container.inert).not.toBe(true);
  expect(document.activeElement).toBe(trigger);
});

test('choosing a search result goes to the page and closes search', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Header /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.type(screen.getByRole('textbox', { name: 'Search pages' }), 'equip');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Equipment/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('link', { name: 'Equipment' }).className).toContain('is-active');
});

let go: (to: string) => void = () => {};
function Navigator() {
  go = useNavigate();
  return null;
}

test('the account menu closes on Escape (back to its trigger), an outside press, tabbing away and a new page', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Header /><button>Page content</button><Navigator /></MemoryRouter>);
  const trigger = screen.getByRole('button', { name: 'Open account menu' });

  await user.click(trigger);
  within(accountMenu()!).getByRole('button', { name: /Sign out/ }).focus();
  await user.keyboard('{Escape}');
  expect(accountMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  await user.click(trigger);
  // Pressing inside the menu keeps it open.
  fireEvent.pointerDown(accountMenu()!.querySelector('.account-menu__identity')!);
  expect(accountMenu()).not.toBeNull();
  fireEvent.pointerDown(document.body);
  expect(accountMenu()).toBeNull();

  await user.click(trigger);
  within(accountMenu()!).getByRole('button', { name: /Sign out/ }).focus();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Page content' }));
  expect(accountMenu()).toBeNull();

  await user.click(trigger);
  act(() => go('/equipment'));
  expect(accountMenu()).toBeNull();
});
