import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => { bridge = await createBrowserBridge(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
afterAll(async () => { if (bridge) await bridge.close(); });

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
    [id, JSON.stringify({City:'Baltimore','Custom gate code':'Blue 7'}), JSON.stringify({'SMS allowed':false,'Preferred contact method':'SMS','Best time to contact':'After 5 pm'})]);
  cleanup();
  render(<MemoryRouter initialEntries={['/profile']}><App /></MemoryRouter>);
  await user.click(await screen.findByRole('button', {name:'Edit contact'}));
  expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Baltimore');
  expect(screen.getByRole('link', {name:'arborcollaboratory@yahoo.com'}).getAttribute('href')).toBe('mailto:arborcollaboratory@yahoo.com');
  if (!process.env.STUDIO_CONTACT_PHONE?.trim()) {
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText('410-555-0149')).toBeNull();
  }
  await user.clear(screen.getByLabelText('City'));
  await user.type(screen.getByLabelText('City'), 'White Hall');
  await user.click(screen.getByRole('button', {name:'Save contact'}));
  await screen.findByText('Changes saved.');
  await waitFor(async () => {
    const result = await bridge.pool.query('SELECT profile_address,contact_preferences FROM "user" WHERE userid=$1',[id]);
    expect(result.rows[0].profile_address).toMatchObject({City:'White Hall','Custom gate code':'Blue 7'});
    expect(result.rows[0].contact_preferences).toMatchObject({'SMS allowed':false,'Preferred contact method':'SMS','Best time to contact':'After 5 pm'});
  });
  // Stale local-only selections must not override the real catalog/billing route.
  window.localStorage.setItem('profile-membership-selection','premium-yearly');
  expect(screen.queryByRole('button',{name:'Change membership option'})).toBeNull();
  await user.click(screen.getByRole('link',{name:/^Manage/}));
  await screen.findByRole('heading',{name:'Membership & passes'});
  const plans=(await screen.findByRole('heading',{name:'Get access'})).closest('section')!;
  await waitFor(()=>expect(plans.textContent).toContain('$95.00'));
  expect(plans.textContent).toContain('$25.00');
  expect(plans.textContent).not.toContain('$19.99');
  expect(plans.textContent).not.toContain('$99.99');
  expect((await bridge.pool.query('SELECT count(*)::int AS n FROM app_membership_billing')).rows[0].n).toBe(0);
  window.localStorage.removeItem('profile-membership-selection');
});

test.each(['profile', 'contact'])('overlapping section saves persist both changes with the real API (%s first)', async (first) => {
  const response = await bridge.fetch('/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'member' }) });
  expect(response.status).toBe(200);
  const id = (await response.json()).data.user.id;
  await bridge.pool.query('UPDATE "user" SET firstname=$2,phone=$3 WHERE userid=$1', [id, 'Before', '4105550182']);
  let writes = 0;
  let release!: () => void;
  const firstWrite = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    if (input === '/api/me/profile' && init.method === 'PATCH' && ++writes === 1)
      return firstWrite.then(() => bridge.fetch(input, init));
    return bridge.fetch(input, init);
  });
  render(<MemoryRouter initialEntries={['/profile']}><App /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit contact' }));
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Changed' } });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '4435550199' } });
  fireEvent.click(screen.getByRole('button', { name: `Save ${first}` }));
  fireEvent.click(screen.getByRole('button', { name: `Save ${first === 'profile' ? 'contact' : 'profile'}` }));
  await waitFor(() => expect(writes).toBe(1));
  await act(async () => release());
  await waitFor(() => expect(writes).toBe(2));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit contact' })).toBeTruthy();
  });
  const saved = (await bridge.pool.query('SELECT firstname,phone FROM "user" WHERE userid=$1', [id])).rows[0];
  expect(saved).toMatchObject({ firstname: 'Changed', phone: '4435550199' });
});
