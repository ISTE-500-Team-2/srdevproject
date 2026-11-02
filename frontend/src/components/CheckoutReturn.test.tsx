// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CheckoutReturn } from './CheckoutReturn';
import { rememberAssistedReturn } from '../lib/checkoutReturn';
const { auth } = vi.hoisted(() => ({ auth: { user: { id: 42, roles: ['member'] }, actor: null as {id:number;roles:string[]} | null } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
afterEach(() => { cleanup(); sessionStorage.clear(); auth.user = {id:42,roles:['member']}; auth.actor = null; });
function Destination() { const l = useLocation(); return <p>{l.pathname + l.search}</p>; }
function mount(path:string) { render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/checkout-return" element={<CheckoutReturn/>}/>
  <Route path="/membership" element={<CheckoutReturn><Destination/></CheckoutReturn>}/>
  <Route path="/admin/members" element={<Destination/>}/>
</Routes></MemoryRouter>); }
for (const kind of ['billing','pass']) {
  test(`${kind}: a member resuming staff-created checkout returns to their own membership page`, () => {
    mount(`/checkout-return?member=42&${kind}=returned`);
    expect(screen.getByText(`/membership?${kind}=returned`)).toBeTruthy();
  });
  test(`${kind}: staff resuming member-created checkout returns to the selected member`, () => {
    auth.user = {id:7,roles:['staff']}; mount(`/checkout-return?member=42&${kind}=cancelled`);
    expect(screen.getByText(`/admin/members?${kind}=cancelled&member=42`)).toBeTruthy();
  });
  test(`${kind}: existing pending sessions with the old member callback preserve staff context`, () => {
    auth.actor = {id:7,roles:['admin']}; rememberAssistedReturn(7,42); mount(`/membership?${kind}=returned`);
    expect(screen.getByText(`/admin/members?${kind}=returned&member=42`)).toBeTruthy();
  });
}
test('stored context cannot send a member or a different signed-in staff account to another member', () => {
  rememberAssistedReturn(7,99); mount('/membership?billing=returned');
  expect(screen.getByText('/membership?billing=returned')).toBeTruthy();
});
test('untrusted return targets cannot become an external redirect', () => {
  auth.user = {id:7,roles:['admin']}; mount('/checkout-return?member=https://bad.invalid&billing=returned');
  expect(screen.getByText('/membership?billing=returned')).toBeTruthy();
});
