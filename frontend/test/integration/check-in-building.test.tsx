import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';
import { waiverAcceptance } from '../../../backend/test/helpers/waiver';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => { bridge = await createBrowserBridge(); }, 120000);
afterAll(async () => { cleanup(); vi.unstubAllGlobals(); await bridge?.close(); }, 30000);
const post = (path: string, body: unknown, csrf?: string) => bridge.fetch('/api'+path, {
  method:'POST', headers:{'Content-Type':'application/json', ...(csrf ? {'X-CSRF-Token':csrf} : {})},
  body:JSON.stringify(body),
});
const mount = () => render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

test('staff choose the physical arrival building and repeating check-in preserves a second-building visit', async () => {
  const member = (await (await post('/auth/demo',{role:'member'})).json()).data;
  const waivers = (await (await bridge.fetch('/api/me/waivers')).json()).data;
  for (const waiver of waivers)
    expect((await post(`/me/waivers/${waiver.id}/sign`,waiverAcceptance(waiver),member.csrfToken)).status).toBe(200);
  const other = (await bridge.pool.query("INSERT INTO building(name) VALUES('Annex') RETURNING buildingid")).rows[0].buildingid;
  const staff = (await (await post('/auth/demo',{role:'admin'})).json()).data;
  expect((await post('/admin/account-mode',{userId:member.user.id},staff.csrfToken)).status).toBe(200);
  const submitted: unknown[] = [];
  vi.stubGlobal('fetch',async (input: Parameters<typeof bridge.fetch>[0], init?: Parameters<typeof bridge.fetch>[1]) => {
    if (input === '/api/me/check-ins') submitted.push(JSON.parse(String(init?.body)));
    return bridge.fetch(input,init);
  });
  const user = userEvent.setup();
  mount();
  const button = () => screen.getByRole('button',{name:new RegExp(`Check ${member.user.firstName} in`)});
  expect(await screen.findByLabelText('Check-in building')).toHaveProperty('value','');
  expect(button()).toHaveProperty('disabled',true);
  await user.selectOptions(screen.getByLabelText('Check-in building'),String(other));
  await waitFor(()=>expect(button()).toHaveProperty('disabled',false));
  await user.click(button());
  await screen.findByText(`${member.user.firstName} is checked in.`);
  expect(submitted).toEqual([{buildingId:other}]);
  const current = async () => (await bridge.pool.query('SELECT building_id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[member.user.id])).rows[0].building_id;
  expect(await current()).toBe(other);

  // A closed first building must not disable arrival in the current building.
  cleanup();
  await bridge.pool.query("UPDATE building SET status='unavailable' WHERE buildingid=1");
  mount();
  expect(await screen.findByLabelText('Check-in building')).toHaveProperty('value',String(other));
  await waitFor(()=>expect(button()).toHaveProperty('disabled',false));
  await user.click(button());
  await screen.findByText(`${member.user.firstName} is checked in.`);
  expect(await current()).toBe(other);
  expect(submitted).toEqual([{buildingId:other},{buildingId:other}]);

  // A transfer remains possible, but only when staff actually select it.
  cleanup();
  await bridge.pool.query("UPDATE building SET status='available' WHERE buildingid=1");
  mount();
  await user.selectOptions(await screen.findByLabelText('Check-in building'),'1');
  await waitFor(()=>expect(button()).toHaveProperty('disabled',false));
  await user.click(button());
  await screen.findByText(`${member.user.firstName} is checked in.`);
  expect(submitted.at(-1)).toEqual({buildingId:1});
  expect(await current()).toBe(1);
});
