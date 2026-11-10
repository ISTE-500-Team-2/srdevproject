// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
const { memberLoaded, auth } = vi.hoisted(() => ({ memberLoaded: vi.fn(), auth: { user: null as unknown, actor: null as unknown } }));
vi.mock('./memberPages', () => { memberLoaded(); return { AppShell: () => <p>Member site</p> }; });
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth, AuthProvider: ({ children }: { children: unknown }) => children }));
import { MemberSite } from '../App';

test('staff landing on Home go to the workspace without downloading the member site', () => {
  auth.user = { id: 1, role: 'admin', roles: ['admin'] };
  render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route element={<MemberSite />}><Route index element={null} /></Route>
    <Route path="/admin" element={<p>Workspace</p>} />
  </Routes></MemoryRouter>);
  expect(screen.getByText('Workspace')).toBeTruthy();
  expect(memberLoaded).not.toHaveBeenCalled();
});

test('members, and staff with a member’s account open, get the member site', async () => {
  for (const [user, actor] of [[{ id: 2, role: 'member', roles: ['member'] }, null], [{ id: 2, role: 'member', roles: ['member'] }, { id: 1, roles: ['staff'] }]]) {
    auth.user = user; auth.actor = actor;
    const view = render(<MemoryRouter initialEntries={['/']}><Routes>
      <Route element={<MemberSite />}><Route index element={null} /></Route>
      <Route path="/admin" element={<p>Workspace</p>} />
    </Routes></MemoryRouter>);
    expect(await screen.findByText('Member site')).toBeTruthy();
    view.unmount();
  }
});
