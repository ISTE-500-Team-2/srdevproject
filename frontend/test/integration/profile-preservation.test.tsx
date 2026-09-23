import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => { bridge = await createBrowserBridge(); });
afterAll(async () => { cleanup(); vi.unstubAllGlobals(); if (bridge) await bridge.close(); });

test('profile form saves visible fields without deleting custom values and omits unconfigured phone', async () => {
  vi.stubGlobal('fetch', bridge.fetch);
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/login']}><App /></MemoryRouter>);
  const demo = await screen.findByRole('button', { name: 'Member demo' });
  await waitFor(() => expect((demo as HTMLButtonElement).disabled).toBe(false));
  await user.click(demo);
  await screen.findByRole('heading', { name: /Welcome back/ });
  const session = await (await bridge.fetch('/api/auth/session')).json();
  const id = session.data.user.id;
  await bridge.pool.query(`UPDATE "user" SET profile_address=$2,contact_preferences=$3 WHERE userid=$1`,
    [id, JSON.stringify({City:'Baltimore','Custom gate code':'Blue 7'}), JSON.stringify({'SMS allowed':false})]);
  cleanup();
  render(<MemoryRouter initialEntries={['/profile']}><App /></MemoryRouter>);
  await screen.findByRole('button', {name:'Save changes'});
  await waitFor(() => expect((screen.getByRole('button', {name:'Save changes'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Baltimore');
  expect(screen.getByRole('link', {name:'arborcollaboratory@yahoo.com'}).getAttribute('href')).toBe('mailto:arborcollaboratory@yahoo.com');
  if (!process.env.STUDIO_CONTACT_PHONE?.trim()) {
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText('410-555-0149')).toBeNull();
  }
  await user.clear(screen.getByLabelText('City'));
  await user.type(screen.getByLabelText('City'), 'White Hall');
  await user.click(screen.getByRole('button', {name:'Save changes'}));
  await screen.findByText('Your profile was saved.');
  await waitFor(async () => {
    const result = await bridge.pool.query('SELECT profile_address,contact_preferences FROM "user" WHERE userid=$1',[id]);
    expect(result.rows[0].profile_address).toEqual({City:'White Hall','Custom gate code':'Blue 7'});
    expect(result.rows[0].contact_preferences).toEqual({'SMS allowed':false});
  });
});
