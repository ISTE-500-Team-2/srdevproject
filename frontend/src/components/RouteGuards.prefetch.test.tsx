// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
