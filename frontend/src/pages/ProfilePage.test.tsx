// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatPhone, ProfilePage } from './ProfilePage';
import { ApiError } from '../lib/api';
const { api, refresh, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  auth: { user: { id: 42, firstName: 'Test', lastName: 'Member', email: 'test@example.com', phone: '4105550182', role: 'member', membership: 'Monthly', username: null as string | null } },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, refresh }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.user.username = null;
});

const profile = {
  address: { 'Street address': '1 Mill Rd', City: 'White Hall', State: 'Maryland', 'Postal code': '21161' },
  contactPreferences: { 'Preferred contact method': 'Email', 'Best time to contact': 'Afternoon' },
  studioContact: { name: 'Test studio', email: 'studio@example.test', phone: '4105550100' },
};
function mount(overrides: Record<string, (init?: { method?: string; body?: unknown }) => unknown> = {}) {
  api.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (overrides[path]) return Promise.resolve().then(() => overrides[path]!(init));
    if (path === '/me/notifications') return Promise.resolve(init?.body ?? { enabled: true, timeZone: 'America/New_York' });
    if (path === '/me/profile') return Promise.resolve(profile);
    if (path === '/me/memberships')
      return Promise.resolve({ memberships: [{ id: 1, effectiveStatus: 'active', endsAt: '2030-11-14T00:00:00Z', plan: { name: 'Monthly' } }], passes: [], timeZone: 'UTC', accessStatus: 'active' });
    if (path.startsWith('/me/payments')) return Promise.resolve({ items: [{ id: 3, amount: '45.00', recordedAt: '2030-10-14T12:00:00Z' }], nextOffset: null });
    if (path === '/me/signed-waivers') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  refresh.mockResolvedValue(undefined);
  return render(<MemoryRouter><ProfilePage /></MemoryRouter>);
}
const section = (name: string) => screen.getByRole('region', { name });
const patches = () => api.mock.calls.filter(([p, o]) => p === '/me/profile' && o?.method === 'PATCH');

test('details read as text first, with a formatted phone and no empty username', async () => {
  mount();
  const contact = section('Contact');
  expect(await within(contact).findByText('1 Mill Rd, White Hall, Maryland 21161')).toBeTruthy();
  expect(within(contact).getByText('(410) 555-0182')).toBeTruthy();
  expect(within(contact).getByText('Email · afternoon')).toBeTruthy();
  expect(within(contact).queryByRole('textbox')).toBeNull();
  expect(screen.queryByText('Username')).toBeNull();
  expect(screen.getByText('Member ID 000042')).toBeTruthy();
});

test('editing one section saves it with the other stored fields unchanged', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit contact' }));
  const contact = section('Contact');
  fireEvent.change(within(contact).getByLabelText('Phone'), { target: { value: '(443) 555-0199' } });
  fireEvent.click(within(contact).getByLabelText('Text'));
  fireEvent.click(within(contact).getByRole('button', { name: 'Save contact' }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]![1]!.body).toEqual({
    firstName: 'Test',
    lastName: 'Member',
    phone: '4435550199',
    address: profile.address,
    contactPreferences: { 'Preferred contact method': 'Text', 'Best time to contact': 'Afternoon' },
  });
  await waitFor(() => expect(screen.getAllByText('Changes saved.')).toHaveLength(1));
  expect(refresh).toHaveBeenCalledOnce();
  expect(within(contact).queryByRole('button', { name: 'Save contact' })).toBeNull();
});

test('a failed save keeps the form open with the error and claims nothing', async () => {
  mount({ '/me/profile': (init) => (init?.method === 'PATCH' ? Promise.reject(new ApiError(400, 'INVALID', 'Unable to save changes.')) : profile) });
  fireEvent.click(await screen.findByRole('button', { name: 'Edit profile' }));
  const box = section('Profile');
  fireEvent.click(within(box).getByRole('button', { name: 'Save profile' }));
  expect((await within(box).findByRole('alert')).textContent).toBe('Unable to save changes.');
  expect(within(box).getByRole('button', { name: 'Save profile' })).toBeTruthy();
  expect(screen.queryByText('Changes saved.')).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});

test('billing is a real summary that links to the membership page', async () => {
  mount();
  const billing = section('Membership & billing');
  expect(await within(billing).findByText('Monthly')).toBeTruthy();
  expect(await within(billing).findByText(/\$45\.00/)).toBeTruthy();
  expect(within(billing).getByRole('link', { name: /Manage/ }).getAttribute('href')).toBe('/membership');
  expect(screen.queryByText('$19.99')).toBeNull();
});

test('the notification switch saves at once and rolls back if saving fails', async () => {
  mount({ '/me/notifications': (init) => (init?.method === 'PATCH' ? Promise.reject(new ApiError(500, 'FAILED', 'Try again.')) : { enabled: true, timeZone: 'America/New_York' }) });
  const toggle = await screen.findByRole('switch', { name: 'Email me' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  expect(await screen.findByText('Try again.')).toBeTruthy();
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});

test('help shows the studio contact from the server', async () => {
  mount();
  const help = section('Need a hand?');
  expect((await within(help).findByRole('link', { name: /studio@example.test/ })).getAttribute('href')).toBe('mailto:studio@example.test');
  expect(within(help).getByRole('link', { name: /\(410\) 555-0100/ }).getAttribute('href')).toBe('tel:4105550100');
});

test('phone numbers format only when they are ten US digits', () => {
  expect(formatPhone('4105550182')).toBe('(410) 555-0182');
  expect(formatPhone('1-410-555-0182')).toBe('(410) 555-0182');
  expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
});
