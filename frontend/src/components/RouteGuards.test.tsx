// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { setAccessToken, setCsrfToken } from '../lib/api';
import { RequireStaff, RequireUser } from './RouteGuards';

let roles = ['member'];
let expired = false;
let unavailable = false;
let calls = 0;
let hold: Promise<void> | undefined;
function session() {
  return { accessToken:'test-token', csrfToken:'test-csrf', user:{id:1,role:'member',roles:[...roles],firstName:'Test'} };
}
function mount(path='/profile') {
  setAccessToken('test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({data:{demoLogin:false}});
    if (url === '/api/auth/logout') { expired=true; return new Response(null,{status:204}); }
    calls++;
    const captured = session();
    if (hold) await hold;
    if (unavailable) throw new TypeError('offline');
    if (expired) return Response.json({error:{code:'UNAUTHORIZED',message:'Expired'}},{status:401});
    return Response.json({data:captured});
  }));
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><Routes>
    <Route path="/login" element={<h1>Sign in</h1>} />
    <Route path="/confirm-email" element={<h1>Public confirmation</h1>} />
    <Route element={<RequireUser />}>
      <Route path="/profile" element={<Protected />} />
      <Route element={<RequireStaff />}><Route path="/admin" element={<h1>Private staff workspace</h1>} /></Route>
    </Route>
  </Routes></AuthProvider></MemoryRouter>);
}
function Protected() {
  const {logout}=useAuth();
  return <><h1>Private profile</h1><input aria-label="Unsaved name" defaultValue="" /><Link to="/admin">Direct staff link</Link>
    <button onClick={()=>void logout()}>Log out</button></>;
}
afterEach(()=>{ cleanup();vi.unstubAllGlobals();setAccessToken(null);setCsrfToken(null);roles=['member'];expired=false;unavailable=false;calls=0;hold=undefined; });

test('signed-out deep links never render protected content', async()=>{
  expired=true; mount('/admin');
  await screen.findByText('Sign in');
  expect(screen.queryByText('Private staff workspace')).toBeNull();
});
test('no private content mounts until session validation finishes',async()=>{
  let release!:()=>void; hold=new Promise(r=>release=r);mount();
  expect(screen.queryByText('Private profile')).toBeNull();release();
  await screen.findByText('Private profile');
});
test.each([['member'],['instructor'],['student']])('role %s receives explicit access denial',async(role)=>{
  roles=[role];mount('/admin');await screen.findByText('Access denied');
  expect(screen.queryByText('Private staff workspace')).toBeNull();
});
test.each([['staff'],['admin']])('role %s can open staff workspace directly',async(role)=>{
  roles=[role];mount('/admin');await screen.findByText('Private staff workspace');
});
test('additional staff role grants access even with member primary role',async()=>{
  roles=['member','staff'];mount('/admin');await screen.findByText('Private staff workspace');
});
test('navigation checks current roles rather than previously cached roles',async()=>{
  roles=['staff'];mount();await screen.findByText('Private profile');
  roles=['member'];fireEvent.click(screen.getByText('Direct staff link'));
  await screen.findByText('Access denied');expect(screen.queryByText('Private staff workspace')).toBeNull();
});
test('returning to a tab revalidates a revoked staff role',async()=>{
  roles=['admin'];mount('/admin');await screen.findByText('Private staff workspace');
  roles=['member'];fireEvent.focus(window);await screen.findByText('Access denied');
});
test('expired session on tab return sends user to login',async()=>{
  mount();await screen.findByText('Private profile');expired=true;fireEvent(window,new Event('pageshow'));
  await screen.findByText('Sign in');expect(screen.queryByText('Private profile')).toBeNull();
});
test('server failure hides protected content and permits retry, not a false login',async()=>{
  unavailable=true;mount();await screen.findByRole('alert');expect(screen.queryByText('Private profile')).toBeNull();
  unavailable=false;fireEvent.click(screen.getByText('Retry'));await screen.findByText('Private profile');
});
test('logout removes protected content',async()=>{
  mount();await screen.findByText('Private profile');fireEvent.click(screen.getByText('Log out'));
  await screen.findByText('Sign in');expect(screen.queryByText('Private profile')).toBeNull();
});
test('late session response cannot restore an expired user',async()=>{
  mount();await screen.findByText('Private profile');const before=calls;
  let release!:()=>void;hold=new Promise(r=>release=r);fireEvent.focus(window);
  await waitFor(()=>expect(calls).toBeGreaterThan(before));
  fireEvent(window,new Event('session-expired'));release();
  await screen.findByText('Sign in');expect(screen.queryByText('Private profile')).toBeNull();
});
test('confirmation remains public with an expired session',async()=>{
  expired=true;mount('/confirm-email');await screen.findByText('Public confirmation');
});

test('tab revalidation preserves unsaved edits for an authorized user',async()=>{
  mount();await screen.findByText('Private profile');
  fireEvent.change(screen.getByLabelText('Unsaved name'),{target:{value:'Keep my edit'}});
  const before=calls;fireEvent.focus(window);
  await waitFor(()=>expect(calls).toBeGreaterThan(before));
  expect((screen.getByLabelText('Unsaved name') as HTMLInputElement).value).toBe('Keep my edit');
});
