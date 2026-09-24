// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { setAccessToken, setCsrfToken } from '../../src/lib/api';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';
let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeEach(async()=>{bridge=await createBrowserBridge();vi.stubGlobal('fetch',bridge.fetch);setAccessToken(null);setCsrfToken(null);});
afterEach(async()=>{cleanup();vi.unstubAllGlobals();setAccessToken(null);setCsrfToken(null);if (bridge) await bridge.close();});
function mount(path:string) { return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); }
async function login(role:string) {
  const r=await bridge.fetch('/api/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});
  expect(r.status).toBe(200);const {data}=await r.json();setAccessToken(data.accessToken);setCsrfToken(data.csrfToken);return data;
}
test.each(['/','/profile','/admin','/membership','/reservations','/certifications','/classes'])('signed-out deep link %s renders login, not protected page',async(path)=>{
  mount(path);await screen.findByLabelText('Password');
  expect(screen.queryByRole('navigation',{name:'Primary navigation'})).toBeNull();
});
test('member deep link is denied by UI AND real staff API',async()=>{
  await login('member');mount('/admin');await screen.findByText('Access denied');
  expect((await bridge.fetch('/api/admin/users')).status).toBe(403);
});
test('existing staff session loses workspace on demotion and API refuses access',async()=>{
  const data=await login('member');
  await bridge.pool.query('DELETE FROM user_role WHERE userid=$1',[data.user.id]);
  await bridge.pool.query("INSERT INTO user_role (userid,roleid) SELECT $1,roleid FROM role WHERE role='staff'",[data.user.id]);
  await bridge.pool.query("UPDATE \"user\" SET primary_role='staff' WHERE userid=$1",[data.user.id]);
  mount('/admin');await screen.findByText('Membership & access management');
  await bridge.pool.query('DELETE FROM user_role WHERE userid=$1',[data.user.id]);
  await bridge.pool.query("INSERT INTO user_role (userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[data.user.id]);
  await bridge.pool.query("UPDATE \"user\" SET primary_role='member' WHERE userid=$1",[data.user.id]);
  fireEvent.focus(window);await screen.findByText('Access denied');
  expect((await bridge.fetch('/api/admin/users')).status).toBe(403);
});
test('revoked server session is removed on page return without reloading the browser',async()=>{
  const data=await login('member');mount('/profile');await screen.findByRole('button',{name:'Save changes'});
  const r=await bridge.fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':data.csrfToken},body:'{}'});
  expect(r.status).toBe(204);fireEvent(window,new Event('pageshow'));await screen.findByLabelText('Password');
  expect(screen.queryByRole('button',{name:'Save changes'})).toBeNull();
});

test('profile save still displays its success popup after refreshing the session',async()=>{
  await login('member');mount('/profile');
  const save=await screen.findByRole('button',{name:'Save changes'});
  fireEvent.click(save);await screen.findByText('Changes saved.');
  // A completed background auth refresh must not unmount and erase the popup.
  fireEvent.focus(window);
  expect(await screen.findByText('Changes saved.')).toBeTruthy();
});
