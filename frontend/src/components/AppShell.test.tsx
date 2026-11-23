// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { api, setAccessToken, setCsrfToken } from '../lib/api';
import { AppShell } from './AppShell';
import { RequireUser } from './RouteGuards';

vi.mock('./Header', () => ({ Header: () => null }));
vi.mock('./Footer', () => ({ Footer: () => null }));
vi.mock('./admin/AccountBar', () => ({ AccountBar: () => null }));

const staff = { id: 2, role: 'staff', roles: ['staff'], firstName: 'Sam' };
// The member account staff member 2 has open; the sign-in is shared by every tab.
let opened = 1;
// The X-Account-Subject each booking was sent with.
let sent: Array<string | null> = [];
function mount() {
  setAccessToken('token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return Response.json({ data: { demoLogin: false } });
    if (url === '/api/auth/session') return Response.json({ data: {
      accessToken: 'token', csrfToken: 'csrf',
      user: { id: opened, role: 'member', roles: ['member'], firstName: `Member ${opened}` },
      actingAs: { actor: staff },
    } });
    if (url === '/api/reservations') {
      sent.push((init?.headers as Record<string, string>)['X-Account-Subject'] ?? null);
      return Response.json({ data: {} });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<MemoryRouter initialEntries={['/equipment']}><AuthProvider><Probe /><Routes>
    <Route element={<RequireUser />}>
      <Route element={<AppShell />}><Route path="/equipment" element={<Bookings />} /></Route>
    </Route>
  </Routes></AuthProvider></MemoryRouter>);
}
const auth: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Probe() { auth.current = useAuth(); return null; }
/** A member page: what it read when it mounted belongs to the account open then. */
function Bookings() {
  const { user } = useAuth();
  const [loadedFor] = useState(user!.id);
  return <>
    <h1>Bookings for account {loadedFor}</h1>
    <input aria-label="Booking note" defaultValue="" />
    <button onClick={() => void api('/reservations', { method: 'POST', body: {} })}>Book</button>
  </>;
}
const note = () => (screen.getByLabelText('Booking note') as HTMLInputElement).value;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null); opened = 1; sent = []; });

test('a member page is rebuilt for the account opened in another tab, and books for that account', async () => {
  mount(); await screen.findByText('Bookings for account 1');
  fireEvent.change(screen.getByLabelText('Booking note'), { target: { value: 'For member 1' } });
  // Another tab switches to member 3; returning to this one rereads the session.
  opened = 3; fireEvent.focus(window);
  await screen.findByText('Bookings for account 3');
  expect(screen.queryByText('Bookings for account 1')).toBeNull();
  expect(note()).toBe('');
  fireEvent.click(screen.getByText('Book'));
  await waitFor(() => expect(sent).toEqual(['3']));
});

test('a change from a page still showing one account names that account, even once the session read found another', async () => {
  mount(); await screen.findByText('Bookings for account 1');
  opened = 3;
  // The read is back, but the page for member 1 has not been replaced yet.
  await auth.current!.refresh(false, { fresh: true });
  expect(screen.getByText('Bookings for account 1')).toBeTruthy();
  fireEvent.click(screen.getByText('Book'));
  // Sent for member 1, so the server (now acting for member 3) refuses it.
  await waitFor(() => expect(sent).toEqual(['1']));
  await screen.findByText('Bookings for account 3');
});
