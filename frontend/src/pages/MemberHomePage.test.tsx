// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MemberHomePage } from './MemberHomePage';
import { ApiError } from '../lib/api';
import type { Overview, SupervisedMinors, SupervisionSummary, User } from '../lib/contracts';

const { api, refresh, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  auth: { user: null as unknown as User },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, notification: null, clearNotification: () => {}, refresh }),
}));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));
// The lanyard is three.js; the badge's inputs are what matter here.
vi.mock('../components/MemberBadge', () => ({
  MemberBadge: (p: { isMinor?: boolean; sponsorName?: string | null }) => (
    <div data-testid="badge">{`${p.isMinor ? 'minor' : 'adult'}|${p.sponsorName ?? ''}`}</div>
  ),
}));

const emma: User = {
  id: 142, firstName: 'Emma', lastName: 'Lin', email: 'emma@example.com', phone: '', role: 'member', roles: ['member'],
  membership: 'Monthly', isMinor: true, sponsorName: 'Dana Reyes',
};
const dana: User = { ...emma, id: 7, firstName: 'Dana', lastName: 'Reyes', isMinor: false, sponsorName: null };
const overview = (o: Partial<Overview> = {}): Overview => ({
  entitlement: { membership: true, dayPass: false },
  pendingWaivers: 0,
  activeReservations: 0,
  canCheckIn: true,
  reasons: [],
  recentCheckIns: [{ id: 1, location: 'Main shop', checkedInAt: '2026-10-30T20:02:00Z', method: 'nfc' }],
  ...o,
});
const visit = { id: 9, buildingId: 1, buildingName: 'Main shop', checkedInAt: '2026-11-02T19:14:00Z', sponsorId: 7 };
const minorSummary = (o: Partial<SupervisionSummary> = {}): SupervisionSummary => ({
  isMinor: true, marker: 'Under 18', sponsor: { id: 7, name: 'Dana Reyes', revision: 1 }, visit: null, pendingRequests: [], ...o,
});
const adultSummary = (o: Partial<SupervisionSummary> = {}): SupervisionSummary => ({
  isMinor: false, marker: null, sponsor: null, visit: null, pendingRequests: [], ...o,
});

function mount(routes: Record<string, unknown | (() => unknown)>) {
  api.mockImplementation((path: string, init?: { method?: string }) => {
    const key = init?.method && init.method !== 'GET' ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) return Promise.resolve(path === '/me/waivers' || path === '/reservations' ? [] : null);
    return Promise.resolve().then(() => (typeof hit === 'function' ? (hit as () => unknown)() : hit));
  });
  refresh.mockResolvedValue(undefined);
  return render(<MemoryRouter><MemberHomePage /></MemoryRouter>);
}
const checkInCard = async () => (await screen.findByRole('heading', { name: 'Check-in' })).closest('article') as HTMLElement;
const accessBand = async () => (await screen.findByText('Your access')).closest('aside') as HTMLElement;

beforeEach(() => sessionStorage.setItem('collaboratory:greeted', '1'));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('no banner above the greeting; a checked-in minor sees the visit in the Check-in card', async () => {
  auth.user = emma;
  mount({ '/me/overview': overview(), '/me/supervision': minorSummary({ visit }) });
  const card = await checkInCard();
  expect(await within(card).findByText('You’re checked in with Dana Reyes.')).toBeTruthy();
  expect(within(card).getByText(/^Since .* · Main shop$/)).toBeTruthy();
  expect(within(card).getByText('Your visit ends when Dana checks out.')).toBeTruthy();
  // The NFC hint is only for members who can check in and aren't here yet.
  expect(screen.queryByText(/Tap your NFC tag/)).toBeNull();
  // Nothing sits between the page and the greeting.
  const intro = screen.getByRole('heading', { level: 1 }).closest('section')!;
  expect(intro.previousElementSibling).toBeNull();
  // Access band: tier pill, Under 18 pill, sponsor line; badge gets the sponsor.
  const band = await accessBand();
  expect(within(band).getByText('Active membership').className).toBe('membership-card__tier');
  expect(within(band).getByText('Under 18').className).toContain('status-pill--warn');
  expect(within(band).getByText('Dana Reyes').closest('p')?.textContent).toBe('Sponsoring adult Dana Reyes');
  expect(screen.getByTestId('badge').textContent).toBe('minor|Dana Reyes');
});

test('checking out from the card posts, refreshes and confirms', async () => {
  auth.user = emma;
  let summary = minorSummary({ visit });
  mount({ '/me/overview': overview(), '/me/supervision': () => summary, 'POST /me/visit/check-out': () => { summary = minorSummary(); return {}; } });
  const card = await checkInCard();
  fireEvent.click(await within(card).findByRole('button', { name: 'Check out' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/me/visit/check-out', { method: 'POST', body: {} }));
  expect(await screen.findByText('You’re checked out. See you next time.')).toBeTruthy();
  expect(await within(card).findByText('You can check in.')).toBeTruthy();
});

test('not checked in: NFC hint appears once, under the last check-in', async () => {
  auth.user = dana;
  mount({ '/me/overview': overview(), '/me/supervision': adultSummary(), '/me/minors': { minors: [], requests: [] } });
  const card = await checkInCard();
  expect(await within(card).findByText('You can check in.')).toBeTruthy();
  expect(within(card).getByText('Last check-in')).toBeTruthy();
  expect(screen.getAllByText(/Tap your NFC tag/)).toHaveLength(1);
  expect(within(card).queryByRole('button', { name: 'Check out' })).toBeNull();
  expect(within(await accessBand()).queryByText('Under 18')).toBeNull();
});

test('blocked: failed status with the fix link and no NFC hint', async () => {
  auth.user = dana;
  mount({
    '/me/overview': overview({ canCheckIn: false, reasons: ['Sign the Shop Safety waiver before you check in.'] }),
    '/me/supervision': adultSummary(),
  });
  const card = await checkInCard();
  expect(await within(card).findByText('Sign the Shop Safety waiver before you check in.')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Review and sign' })).toBeTruthy();
  expect(screen.queryByText(/Tap your NFC tag/)).toBeNull();
});

test('an adult supervising a checked-in minor sees them in the card and access band', async () => {
  auth.user = dana;
  const minors: SupervisedMinors = {
    minors: [{ id: 142, name: 'Emma Lin', visit: { buildingName: 'Main shop', checkedInAt: visit.checkedInAt } }],
    requests: [],
  };
  mount({ '/me/overview': overview(), '/me/supervision': adultSummary({ visit: { ...visit, sponsorId: null } }), '/me/minors': minors });
  const card = await checkInCard();
  expect(await within(card).findByText('You’re checked in, supervising Emma Lin.')).toBeTruthy();
  expect(within(card).getByText('Checking out also ends Emma’s visit.')).toBeTruthy();
  expect(within(await accessBand()).getByText('Emma Lin').closest('p')?.textContent).toBe('Supervising Emma Lin');
});

test('a minor accepts a pending sponsor request from the access band', async () => {
  auth.user = { ...emma, sponsorName: null };
  let summary = minorSummary({ sponsor: null, pendingRequests: [{ id: 3, adultName: 'James Lin', createdAt: '2026-11-02T12:00:00Z' }] });
  mount({
    '/me/overview': overview(),
    '/me/supervision': () => summary,
    'POST /me/sponsor-requests/3/accept': () => {
      summary = minorSummary({ sponsor: { id: 8, name: 'James Lin', revision: 1 } });
      return summary;
    },
  });
  const band = await accessBand();
  expect(await within(band).findByText(/asked to be your sponsoring adult/)).toBeTruthy();
  expect(within(band).queryByText(/No sponsoring adult linked yet/)).toBeNull();
  fireEvent.click(within(band).getByRole('button', { name: 'Accept request from James Lin' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/me/sponsor-requests/3/accept', { method: 'POST', body: {} }));
  expect(await screen.findByText('James Lin is now your sponsoring adult.')).toBeTruthy();
  expect(refresh).toHaveBeenCalled();
  await waitFor(() => expect(within(band).getByText('James Lin').closest('p')?.textContent).toBe('Sponsoring adult James Lin'));
  expect(within(band).queryByRole('button', { name: /Accept request/ })).toBeNull();
});

test('declining shows the server error in place when it fails', async () => {
  auth.user = { ...emma, sponsorName: null };
  mount({
    '/me/overview': overview(),
    '/me/supervision': minorSummary({ sponsor: null, pendingRequests: [{ id: 3, adultName: 'James Lin', createdAt: '2026-11-02T12:00:00Z' }] }),
    'POST /me/sponsor-requests/3/decline': () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'No pending sponsor request found.')),
  });
  const band = await accessBand();
  fireEvent.click(await within(band).findByRole('button', { name: 'Decline request from James Lin' }));
  expect((await within(band).findByRole('alert')).textContent).toBe('No pending sponsor request found.');
});

test('if the supervision request fails the card keeps its normal state', async () => {
  auth.user = dana;
  mount({
    '/me/overview': overview(),
    '/me/supervision': () => Promise.reject(new ApiError(500, 'REQUEST_FAILED', 'The request could not be completed.')),
  });
  const card = await checkInCard();
  expect(await within(card).findByText('You can check in.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('eligible building check-in explains that reserved resources must wait', async () => {
  auth.user = dana;
  api.mockImplementation((path: string) => Promise.resolve({
    '/me/overview': overview(),
    '/me/supervision': adultSummary(),
    '/me/minors': { minors: [], requests: [] },
  }[path]));
  render(<MemoryRouter><MemberHomePage /></MemoryRouter>);
  const card = await checkInCard();
  expect(within(card).getByText('Building check-in is available before your reservation. Wait until its start time to use your reserved room or equipment.')).toBeTruthy();
  expect(within(card).getByText('Tap your NFC tag at the door. Forgot it? Ask staff.')).toBeTruthy();
});
