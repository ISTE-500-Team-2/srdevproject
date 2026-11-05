import {afterAll, beforeAll, expect, test, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import App from '../../src/App';
import {createBrowserBridge} from '../../../backend/test/helpers/browserBridge';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => { bridge = await createBrowserBridge(); }, 120000);
afterAll(async () => { cleanup(); vi.unstubAllGlobals(); await bridge?.close(); }, 30000);

test('actual CNC eligibility blocks the payment form and points an unsigned member to waivers', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  let creates = 0;
  vi.stubGlobal('fetch', async (input: string, options: RequestInit = {}) => {
    if (input === '/api/reservations' && options.method === 'POST') creates++;
    return bridge.fetch(input, options);
  });
  expect((await bridge.fetch('/api/auth/demo', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({role: 'member'})})).status).toBe(200);
  render(<MemoryRouter initialEntries={['/equipment']}><App/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', {name: /^CNC Machine/}));
  const dialog = within(screen.getByRole('dialog'));
  const pay = dialog.getByRole('button', {name: /confirm reservation/i});
  expect((pay as HTMLButtonElement).disabled).toBe(true);
  expect(dialog.getByRole('link', {name: 'Review your waivers and certifications'}).getAttribute('href')).toBe('/certifications');
  fireEvent.submit(pay.closest('form')!);
  expect((await dialog.findByRole('alert')).textContent).toContain('Signed waivers required');
  expect(creates).toBe(0);
  expect((await bridge.pool.query('SELECT 1 FROM reservation')).rowCount).toBe(0);
});
