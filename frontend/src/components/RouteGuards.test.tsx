// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { setAccessToken, setCsrfToken } from '../lib/api';
import { RequireStaff, RequireUser } from './RouteGuards';

let roles = ['member'];
let actorRoles: string[] | null = null;
let expired = false;
let unavailable = false;
let rateLimited = false;
let gatewayDown = false;
let noToken = false;
let csrfHold: Promise<void> | undefined;
let calls = 0;
let hold: Promise<void> | undefined;
function session() {
  return { accessToken:'test-token', csrfToken:'test-csrf', user:{id:1,role:'member',roles:[...roles],firstName:'Test'},
    actingAs: actorRoles ? { actor:{id:2,role:'staff',roles:[...actorRoles],firstName:'Staff'} } : null };
}
function mount(path='/profile') {
  setAccessToken(noToken ? null : 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({data:{demoLogin:false}});
    if (url === '/api/auth/logout') { expired=true; return new Response(null,{status:204}); }
    calls++;
    const captured = session();
    if (hold && url === '/api/auth/session') await hold;
    if (csrfHold && url === '/api/auth/csrf') await csrfHold;
    if (unavailable) throw new TypeError('offline');
    if (gatewayDown) return Response.json({error:'Application unavailable'},{status:502});
    if (rateLimited) return Response.json({error:{code:'RATE_LIMITED',message:'Please try again later.'}},{status:429});
    if (expired) return Response.json({error:{code:'UNAUTHORIZED',message:'Expired'}},{status:401});
    return Response.json({data:captured});
  }));
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><Probe /><Link to="/admin">Header staff link</Link><Routes>
    <Route path="/login" element={<><h1>Sign in</h1><Where /></>} />
    <Route path="/confirm-email" element={<h1>Public confirmation</h1>} />
    <Route element={<RequireUser />}>
      <Route path="/profile" element={<Protected />} />
      <Route element={<RequireStaff />}><Route path="/admin" element={<h1>Private staff workspace</h1>} /></Route>
    </Route>
  </Routes></AuthProvider></MemoryRouter>);
}
const authProbe:{current:ReturnType<typeof useAuth>|null}={current:null};
function Probe() { authProbe.current=useAuth(); return null; }
function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="Login URL">{pathname + search}</output>;
}
function Protected() {
  const {logout,refresh}=useAuth();
  return <><h1>Private profile</h1><input aria-label="Unsaved name" defaultValue="" /><Link to="/admin">Direct staff link</Link><Link to="/profile?section=contact">Same page link</Link>
    <button onClick={()=>void logout()}>Log out</button>
    <button onClick={()=>{void refresh();void refresh(true);}}>Background then blocking check</button>
    <button onClick={()=>{void refresh();void refresh(false,{fresh:true});}}>Background then fresh check</button></>;
}
// Each tick in its own act, so React re-arms the countdown between seconds.
const elapse=async(ms:number)=>{for(let t=0;t<ms;t+=250)await act(()=>vi.advanceTimersByTimeAsync(250));};
const pageshow=(persisted:boolean)=>fireEvent(window,new PageTransitionEvent('pageshow',{persisted}));
afterEach(()=>{ cleanup();vi.useRealTimers();vi.unstubAllGlobals();setAccessToken(null);setCsrfToken(null);roles=['member'];actorRoles=null;expired=false;unavailable=false;rateLimited=false;gatewayDown=false;noToken=false;csrfHold=undefined;calls=0;hold=undefined; });

test('signed-out deep links never render protected content', async()=>{
  expired=true; mount('/admin');
  await screen.findByText('Sign in');
  expect(screen.queryByText('Private staff workspace')).toBeNull();
});
test('the login redirect remembers the page that was asked for', async()=>{
  expired=true; mount('/admin?tab=members');
  await screen.findByText('Sign in');
  expect(screen.getByLabelText('Login URL').textContent).toBe('/login?next=%2Fadmin%3Ftab%3Dmembers');
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
test('staff with a member account open can still reach the workspace',async()=>{
  roles=['member'];actorRoles=['staff'];mount('/admin');await screen.findByText('Private staff workspace');
});
test('a member account without a staff actor is still kept out',async()=>{
  roles=['member'];actorRoles=['member'];mount('/admin');await screen.findByText('Access denied');
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
  mount();await screen.findByText('Private profile');expired=true;pageshow(true);
  await screen.findByText('Sign in');expect(screen.queryByText('Private profile')).toBeNull();
});
test('server failure hides protected content and permits retry, not a false login',async()=>{
  unavailable=true;mount();await screen.findByRole('alert');expect(screen.queryByText('Private profile')).toBeNull();
  expect(screen.getByRole('heading',{name:'We can’t reach the server'})).toBeTruthy();
  unavailable=false;fireEvent.click(screen.getByRole('button',{name:'Try again'}));await screen.findByText('Private profile');
});
test('returning to the tab during an outage retries instead of sending the person to sign in',async()=>{
  unavailable=true;mount();await screen.findByRole('alert');const before=calls;
  fireEvent.focus(window);await waitFor(()=>expect(calls).toBe(before+1));
  await screen.findByRole('button',{name:'Try again'});
  expect(screen.queryByText('Sign in')).toBeNull();
  expect(screen.getByRole('heading',{name:'We can’t reach the server'})).toBeTruthy();
  unavailable=false;fireEvent.focus(window);await screen.findByText('Private profile');
});
// Fully simulated time: no real-time drift when the suite runs under load.
async function until(found:()=>unknown){
  for(let i=0;i<50&&!found();i++)await act(()=>vi.advanceTimersByTimeAsync(0));
  expect(found()).toBeTruthy();
}
test('an outage page retries on its own, waiting longer each time',async()=>{
  vi.useFakeTimers();
  unavailable=true;mount();await until(()=>screen.queryByRole('alert'));const before=calls;
  expect(screen.getByText('0:05')).toBeTruthy();
  await elapse(4000);expect(calls).toBe(before);
  await elapse(1000);expect(calls).toBe(before+1);
  await until(()=>screen.queryByText('0:10'));
  await elapse(9000);expect(calls).toBe(before+1);
  await elapse(1000);expect(calls).toBe(before+2);
  unavailable=false;
  await elapse(20000);
  await until(()=>screen.queryByText('Private profile'));expect(calls).toBe(before+3);
});
test('a hidden tab pauses automatic retries',async()=>{
  vi.useFakeTimers();
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
  try {
    unavailable=true;mount();await until(()=>screen.queryByRole('alert'));const before=calls;
    await elapse(60000);expect(calls).toBe(before);
  } finally { delete (document as {visibilityState?:string}).visibilityState; }
});
test('navigating away during a stalled retry is not held up by it',async()=>{
  roles=['staff'];unavailable=true;mount();await screen.findByRole('alert');
  // Retry A stalls; the person then follows a header link, whose own check succeeds.
  let release!:()=>void;hold=new Promise(r=>release=r);unavailable=false;
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await screen.findByRole('button',{name:'Trying again…'});
  hold=undefined;fireEvent.click(screen.getByText('Header staff link'));
  await screen.findByText('Private staff workspace');
  release();await new Promise(r=>setTimeout(r,0));
  expect(screen.getByText('Private staff workspace')).toBeTruthy();
});
test.each([
  ['a tab return',()=>fireEvent.focus(window)],
  ['coming back online',()=>fireEvent(window,new Event('online'))],
])('%s replaces a stalled retry instead of waiting on it',async(_name,recover)=>{
  unavailable=true;mount();await screen.findByRole('alert');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await screen.findByRole('button',{name:'Trying again…'});
  // The connection is back; the stalled read has not answered.
  hold=undefined;unavailable=false;recover();
  await screen.findByText('Private profile');
  // When the stalled read finally fails, it cannot undo the newer, successful check.
  unavailable=true;release();await new Promise(r=>setTimeout(r,0));
  expect(screen.getByText('Private profile')).toBeTruthy();
});
test('an attempt with no answer is replaced after a while',async()=>{
  vi.useFakeTimers();
  unavailable=true;mount();await until(()=>screen.queryByRole('alert'));
  hold=new Promise(()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await until(()=>screen.queryByRole('button',{name:'Trying again…'}));const stalled=calls;
  hold=undefined;unavailable=false;
  await elapse(14000);expect(calls).toBe(stalled);
  await elapse(1000);
  await until(()=>screen.queryByText('Private profile'));expect(calls).toBe(stalled+1);
});
test('a credential check that never answers does not hold up recovery',async()=>{
  vi.useFakeTimers();
  // A fresh load with no access token renews first; that renewal is shared by every request.
  noToken=true;unavailable=true;mount();await until(()=>screen.queryByRole('alert'));
  csrfHold=new Promise(()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await until(()=>screen.queryByRole('button',{name:'Trying again…'}));
  csrfHold=undefined;unavailable=false;
  await elapse(25000);
  await until(()=>screen.queryByText('Private profile'));
});
test('coming back online retries at once',async()=>{
  unavailable=true;mount();await screen.findByRole('alert');
  unavailable=false;fireEvent(window,new Event('online'));
  await screen.findByText('Private profile');
});
test('a proxy reporting the app as down reads as a connection problem',async()=>{
  gatewayDown=true;mount();
  await screen.findByRole('heading',{name:'We can’t reach the server'});
});
test('a server error answer shows its message rather than a connection problem',async()=>{
  rateLimited=true;mount();
  await screen.findByRole('heading',{name:'Your account didn’t load'});
  expect(screen.getByText(/Please try again later\./)).toBeTruthy();
});

test('a member sent to the staff workspace sees a titled access-denied page',async()=>{
  document.title='Login · The Collaboratory';mount('/admin');await screen.findByText('Access denied');
  await waitFor(()=>expect(document.title).toBe('Access denied · The Collaboratory'));
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

test('opening a protected page reads the session once',async()=>{
  roles=['staff'];mount('/admin');await screen.findByText('Private staff workspace');
  // An ordinary load's pageshow is not a restoration and must not re-read.
  pageshow(false);
  await new Promise(r=>setTimeout(r,20));
  expect(calls).toBe(1);
});
test('navigation to a new location issues its own session check',async()=>{
  roles=['staff'];mount();await screen.findByText('Private profile');expect(calls).toBe(1);
  fireEvent.click(screen.getByText('Direct staff link'));
  await screen.findByText('Private staff workspace');expect(calls).toBe(2);
});
test('a focus read in flight at the old location is not reused by a navigation',async()=>{
  roles=['staff'];mount();await screen.findByText('Private profile');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.focus(window);await waitFor(()=>expect(calls).toBe(2));
  // The focus read captured the staff role and stays stalled; the navigation
  // reads for itself (it would wait forever if it joined) and sees the demotion.
  roles=['member'];hold=undefined;fireEvent.click(screen.getByText('Direct staff link'));
  await waitFor(()=>expect(calls).toBe(3));
  await screen.findByText('Access denied');
  // The stalled, older read cannot bring the staff workspace back.
  release();
  await new Promise(r=>setTimeout(r,20));
  expect(screen.queryByText('Private staff workspace')).toBeNull();
});
test('moving between protected pages shows the next page at once while the session is rechecked',async()=>{
  roles=['staff'];mount();await screen.findByText('Private profile');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.click(screen.getByText('Direct staff link'));
  await waitFor(()=>expect(calls).toBe(2));
  // No blank "Loading your account…" screen between pages.
  expect(screen.getByText('Private staff workspace')).toBeTruthy();
  expect(screen.queryByText('Loading your account…')).toBeNull();
  release();await new Promise(r=>setTimeout(r,0));
  expect(screen.getByText('Private staff workspace')).toBeTruthy();
});
test('a link within the same page keeps unsaved edits and still rechecks the session',async()=>{
  mount();await screen.findByText('Private profile');
  fireEvent.change(screen.getByLabelText('Unsaved name'),{target:{value:'Keep my edit'}});
  fireEvent.click(screen.getByText('Same page link'));
  await waitFor(()=>expect(calls).toBe(2));
  expect((screen.getByLabelText('Unsaved name') as HTMLInputElement).value).toBe('Keep my edit');
});
test('a navigation that finds the session expired sends the user to login',async()=>{
  mount();await screen.findByText('Private profile');expired=true;
  fireEvent.click(screen.getByText('Same page link'));
  await screen.findByText('Sign in');expect(screen.queryByText('Private profile')).toBeNull();
});
test('only a back/forward-cache pageshow revalidates the session',async()=>{
  mount();await screen.findByText('Private profile');
  pageshow(false);await new Promise(r=>setTimeout(r,20));expect(calls).toBe(1);
  pageshow(true);await waitFor(()=>expect(calls).toBe(2));
});
test('a blocking check that joins a background read stays blocked until it settles',async()=>{
  mount();await screen.findByText('Private profile');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.click(screen.getByText('Background then blocking check'));
  await screen.findByText('Loading your account…');expect(calls).toBe(2);
  expect(screen.queryByText('Private profile')).toBeNull();
  release();await screen.findByText('Private profile');expect(calls).toBe(2);
});
test('a fresh refresh after a write does not reuse an earlier read',async()=>{
  mount();await screen.findByText('Private profile');
  fireEvent.click(screen.getByText('Background then fresh check'));
  await waitFor(()=>expect(calls).toBe(3));
});
test('a read in flight before an auth transition is not joined afterwards',async()=>{
  mount();await screen.findByText('Private profile');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.focus(window);await waitFor(()=>expect(calls).toBe(2));
  // Opening an account at the same location supersedes the focus read.
  await authProbe.current!.openAccount(5);expect(calls).toBe(3);
  void authProbe.current!.refresh();
  await waitFor(()=>expect(calls).toBe(4));release();
  await screen.findByText('Private profile');
});
test('a session-expired event still wins over a read it interrupted',async()=>{
  mount();await screen.findByText('Private profile');
  let release!:()=>void;hold=new Promise(r=>release=r);
  fireEvent.focus(window);await waitFor(()=>expect(calls).toBe(2));
  fireEvent(window,new Event('session-expired'));await screen.findByText('Sign in');
  void authProbe.current!.refresh();
  await waitFor(()=>expect(calls).toBe(3));expired=true;release();
  await new Promise(r=>setTimeout(r,20));expect(screen.queryByText('Private profile')).toBeNull();
});

test('every tab return revalidates anew; a stalled earlier check cannot keep a revoked role', async () => {
  roles = ['staff'];
  mount('/admin');
  await screen.findByText('Private staff workspace');
  // A return's check stalls; staff access is then revoked elsewhere.
  let release!: () => void; hold = new Promise((r) => { release = r; });
  const before = calls;
  fireEvent.focus(window);
  await waitFor(() => expect(calls).toBe(before + 1));
  roles = ['member'];
  hold = undefined;
  // The next return starts its own check instead of joining the stalled one.
  fireEvent.focus(window);
  await waitFor(() => expect(calls).toBe(before + 2));
  await screen.findByText('Access denied');
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText('Private staff workspace')).toBeNull();
});
