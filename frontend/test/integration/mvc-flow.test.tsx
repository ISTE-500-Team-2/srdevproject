// @vitest-environment jsdom
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { api } from '../../src/lib/api';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (bridge) await bridge.close();
}, 30000);
function mount(path = '/login') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

test('React → Express controllers/models → PostgreSQL: login, save, refresh, cancel, waive and check in', async () => {
  vi.stubGlobal('fetch', bridge.fetch);
  const config = await fetch('/api/config');
  expect(config.status).toBe(200);
  expect((await config.json()).data.demoLogin).toBe(true);
  expect((await api<{ demoLogin: boolean }>('/config')).demoLogin).toBe(true);
  const user = userEvent.setup();
  mount();
  const demo = await screen.findByRole(
    'button',
    { name: 'Member demo' },
    { timeout: 20000 },
  );
  await waitFor(
    () => expect((demo as HTMLButtonElement).disabled).toBe(false),
    { timeout: 20000 },
  );
  await user.click(demo);
  await screen.findByRole(
    'heading',
    { name: /Welcome back/ },
    { timeout: 20000 },
  );
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Reservations', exact: true }),
  );
  await user.click(
    await screen.findByRole(
      'button',
      { name: /3D Printer/ },
      { timeout: 20000 },
    ),
  );
  const dialog = screen.getByRole('dialog');
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setHours(14, 0, 0, 0);
  const local =
    [
      start.getFullYear(),
      String(start.getMonth() + 1).padStart(2, '0'),
      String(start.getDate()).padStart(2, '0'),
    ].join('-') + 'T14:00';
  fireEvent.change(within(dialog).getByLabelText(/Start date and time/), {
    target: { value: local },
  });
  await user.click(
    within(dialog).getByRole('button', { name: 'Confirm reservation' }),
  );
  await screen.findByText(
    'Reservation saved for 3D Printer.',
    {},
    { timeout: 20000 },
  );
  await waitFor(
    async () => {
      const result = await bridge.pool.query(
        "SELECT COUNT(*)::int AS count FROM reservation WHERE status='confirmed'",
      );
      expect(result.rows[0].count).toBe(1);
    },
    { timeout: 20000 },
  );
  cleanup();
  mount('/reservations');
  await screen.findByRole(
    'button',
    { name: 'Cancel reservation' },
    { timeout: 20000 },
  );
  await user.click(screen.getByRole('button', { name: 'Cancel reservation' }));
  await screen.findByText('Reservation cancelled.', {}, { timeout: 20000 });
  const cancelled = await bridge.pool.query(
    "SELECT COUNT(*)::int AS count FROM reservation WHERE status='cancelled'",
  );
  expect(cancelled.rows[0].count).toBe(1);
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Certifications & Waivers', exact: true }),
  );
  await user.click(
    await screen.findByRole(
      'button',
      { name: 'Review and agree' },
      { timeout: 20000 },
    ),
  );
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Record agreement' }));
  await screen.findByText(
    'Your agreement has been recorded.',
    {},
    { timeout: 20000 },
  );
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Home', exact: true }),
  );
  const checkin = await screen.findByRole(
    'button',
    { name: 'Check in' },
    { timeout: 20000 },
  );
  await waitFor(
    () => expect((checkin as HTMLButtonElement).disabled).toBe(false),
    { timeout: 20000 },
  );
  await user.click(checkin);
  await screen.findByText(
    'Check-in saved. Welcome to the Collaboratory!',
    {},
    { timeout: 20000 },
  );
  expect(
    (await bridge.pool.query('SELECT COUNT(*)::int AS count FROM check_in'))
      .rows[0].count,
  ).toBe(1);
}, 120000);
