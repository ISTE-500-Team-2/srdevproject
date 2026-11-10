// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import { setAccessToken, setCsrfToken } from '../lib/api';
import { useApi } from '../lib/useApi';
import { RequireUser } from './RouteGuards';

const requests: string[] = [];
function stubServer() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    if (url === '/api/config') return Response.json({ data: { demoLogin: false } });
    if (url === '/api/auth/session')
      return Response.json({ data: { accessToken: 't', csrfToken: 'c', user: { id: 1, role: 'member', roles: ['member'], firstName: 'T' } } });
    return Response.json({ data: { plan: 'Monthly' } });
  }));
}
function Membership() {
  const { data } = useApi<{ plan: string }>('/me/memberships');
  return <h1>Private membership {data?.plan ?? '…'}</h1>;
}
const mount = () => render(<MemoryRouter initialEntries={['/membership']}><AuthProvider><Routes>
  <Route element={<RequireUser />}><Route path="/membership" element={<Membership />} /></Route>
</Routes></AuthProvider></MemoryRouter>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); requests.length = 0; window.history.replaceState(null, '', '/'); });

test('a revisited page starts its reads during the session check but renders only after it passes', async () => {
  window.history.replaceState(null, '', '/membership');
  setAccessToken('t');
  stubServer();
  mount();
  expect(await screen.findByText('Private membership Monthly')).toBeTruthy();
  expect(requests.filter((u) => u === '/api/me/memberships')).toHaveLength(1);
  cleanup();
  requests.length = 0;

  // Second visit: hold the session check open.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  stubServer();
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
    const path = String(url);
    requests.push(path);
    if (path === '/api/config') return Response.json({ data: { demoLogin: false } });
    if (path === '/api/auth/session') {
      await gate;
      return Response.json({ data: { accessToken: 't', csrfToken: 'c', user: { id: 1, role: 'member', roles: ['member'], firstName: 'T' } } });
    }
    return Response.json({ data: { plan: 'Annual' } });
  });
  mount();
  await waitFor(() => expect(requests).toContain('/api/me/memberships'));
  // The page's data is already on its way, yet nothing protected is mounted.
  expect(screen.queryByText(/Private membership/)).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Loading your account');
  open();
  expect(await screen.findByText('Private membership Annual')).toBeTruthy();
  // The page used the prefetched result instead of reading again.
  expect(requests.filter((u) => u === '/api/me/memberships')).toHaveLength(1);
});

test('when the session now belongs to someone else, the previous identity\'s cached data never renders', async () => {
  // Alice's tab has her membership cached; elsewhere she signs out and Bob signs in.
  window.history.replaceState(null, '', '/membership');
  setAccessToken('t');
  stubServer();
  mount();
  expect(await screen.findByText('Private membership Monthly')).toBeTruthy();
  cleanup();

  let answer!: () => void;
  const bobsRecord = new Promise<void>((resolve) => { answer = resolve; });
  const seen: string[] = [];
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/api/config') return Response.json({ data: { demoLogin: false } });
    if (path === '/api/auth/session')
      return Response.json({ data: { accessToken: 'b', csrfToken: 'c', user: { id: 2, role: 'member', roles: ['member'], firstName: 'Bob' } } });
    await bobsRecord;
    return Response.json({ data: { plan: 'Bob plan' } });
  });
  const observer = new MutationObserver(() => { const h = document.querySelector('h1'); if (h) seen.push(h.textContent ?? ''); });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  mount();
  await waitFor(() => expect(screen.getByRole('heading').textContent).toContain('Private membership'));
  answer();
  expect(await screen.findByText('Private membership Bob plan')).toBeTruthy();
  observer.disconnect();
  expect(seen.some((text) => text.includes('Monthly'))).toBe(false);
});

test('a panel opened after the page arrives reads for itself, never a prefetch made for the arrival', async () => {
  let owner = 'A';
  const served: string[] = [];
  function History() {
    const [open, setOpen] = useState(false);
    return <><h1>History</h1><button onClick={() => setOpen(true)}>Payments</button>{open ? <Payments /> : null}</>;
  }
  function Payments() {
    const { data } = useApi<{ owner: string }>('/me/payments?offset=0');
    return <p>Payments for {data?.owner ?? '…'}</p>;
  }
  const mountHistory = () => render(<MemoryRouter initialEntries={['/membership']}><AuthProvider><Routes>
    <Route element={<RequireUser />}><Route path="/membership" element={<History />} /></Route>
  </Routes></AuthProvider></MemoryRouter>);
  window.history.replaceState(null, '', '/membership');
  setAccessToken('t');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({ data: { demoLogin: false } });
    if (url === '/api/auth/session')
      return Response.json({ data: { accessToken: 't', csrfToken: 'c', user: { id: 9, role: 'staff', roles: ['staff'], firstName: 'S' } } });
    served.push(owner);
    return Response.json({ data: { owner } });
  }));
  // First visit: open the panel, so the route remembers its read.
  mountHistory();
  fireEvent.click(await screen.findByRole('button', { name: 'Payments' }));
  expect(await screen.findByText('Payments for A')).toBeTruthy();
  cleanup();
  // Revisit: the guard prefetches the panel's read for account A while checking the session.
  mountHistory();
  await screen.findByRole('heading', { name: 'History' });
  await waitFor(() => expect(served).toHaveLength(2));
  // Elsewhere, account mode switches to B; then the panel is opened.
  owner = 'B';
  fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
  expect(await screen.findByText('Payments for B')).toBeTruthy();
  expect(served).toEqual(['A', 'A', 'B']);
});
