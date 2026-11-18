// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const { auth } = vi.hoisted(() => ({
  auth: {
    user: { id: 2, firstName: 'Morgan', role: 'member', roles: ['member'] } as unknown,
    actor: null as unknown,
    loading: false,
    error: '',
    signedOut: false,
    refresh: async () => {},
  },
}));
vi.mock('./context/AuthContext', () => ({ useAuth: () => auth, AuthProvider: ({ children }: { children: unknown }) => children }));
vi.mock('./areas/memberPages', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => (
      <div>
        <header>Site menu</header>
        <main>
          <Outlet />
        </main>
      </div>
    ),
  };
});
import App from './App';

afterEach(cleanup);

test('a mistyped address shows a member-facing 404 inside the site frame', async () => {
  render(<MemoryRouter initialEntries={['/equipmnt']}><App /></MemoryRouter>);
  const main = await screen.findByRole('main');
  const heading = await within(main).findByRole('heading', { name: 'That project isn’t on this bench.' });
  expect(heading).toBeTruthy();
  expect(screen.getByRole('banner').textContent).toBe('Site menu');
  expect(within(main).getByRole('link', { name: /Back home/ }).getAttribute('href')).toBe('/');
  expect(main.textContent).not.toMatch(/prototype/i);
  expect(document.title).toBe('Page not found · The Collaboratory');
});
