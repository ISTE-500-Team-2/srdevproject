import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { setAccessToken, setCsrfToken } from '../../src/lib/api';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>,classId:number,memberId:number;
async function post(path:string,body:unknown,csrf?:string){
  const response=await bridge.fetch('/api'+path,{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});
  expect(response.status).toBeLessThan(300);return (await response.json()).data;
}
beforeAll(async()=>{
  bridge=await createBrowserBridge();
  const admin=await post('/auth/demo',{role:'admin'});
  memberId=(await bridge.pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  await bridge.pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin.user.id]);
  const course=await post('/training/catalog',{name:'Roster UI safety',description:'Isolated test',validityDays:30,equipmentIds:[],reason:'Regression fixture'},admin.csrfToken);
  const room=(await bridge.pool.query("SELECT roomid FROM room WHERE status='available' AND capacity>=2 LIMIT 1")).rows[0].roomid;
  const start=Date.now()+86400000;
  const c=await post('/classes',{title:'Privacy-safe orientation',certificationId:course.id,instructorId:admin.user.id,roomId:room,capacity:2,startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),reason:'Regression fixture'},admin.csrfToken);
  classId=c.id;
  await bridge.pool.query('INSERT INTO app_training_enrollment(class_id,user_id) VALUES($1,$2)',[classId,memberId]);
},120000);
afterEach(()=>{cleanup();vi.unstubAllGlobals();setAccessToken(null);setCsrfToken(null);});
afterAll(async()=>{await bridge?.close();},30000);
function mount(){vi.stubGlobal('fetch',bridge.fetch);render(<MemoryRouter initialEntries={['/classes']}><App/></MemoryRouter>);}

test('member can open participants, refresh seats after withdrawal, and never sees instructor contact/actions',async()=>{
  await post('/auth/demo',{role:'member'});mount();const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'Details for Privacy-safe orientation'}));
  const panel=await screen.findByRole('region',{name:'Privacy-safe orientation details'});
  expect(await within(panel).findByText('Jordan D.')).toBeTruthy();
  expect(within(panel).getByText('1/2')).toBeTruthy();
  expect(panel.textContent).not.toMatch(/demo.member@|collaboratory.invalid|Member \d|Open Training/);
  expect(screen.queryByRole('button',{name:'Schedule class'})).toBeNull();
  await bridge.pool.query("UPDATE app_training_enrollment SET status='cancelled' WHERE class_id=$1 AND user_id=$2",[classId,memberId]);
  // The page refreshes on focus when nothing is being edited.
  await act(async()=>{window.dispatchEvent(new Event('focus'));});
  expect(await within(panel).findByText('Nobody has registered yet.')).toBeTruthy();
  expect(within(panel).getByText('0/2')).toBeTruthy();
  expect(within(panel).queryByText('Jordan D.')).toBeNull();
});

test('assigned instructor retains the detailed roster and training link',async()=>{
  await bridge.pool.query("UPDATE app_training_enrollment SET status='enrolled' WHERE class_id=$1 AND user_id=$2",[classId,memberId]);
  await post('/auth/demo',{role:'admin'});mount();const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'Roster for Privacy-safe orientation'}));
  const panel=await screen.findByRole('region',{name:'Privacy-safe orientation roster'});
  expect(await within(panel).findByText(/demo.member@collaboratory.invalid/)).toBeTruthy();
  expect(screen.getByRole('link',{name:'Open Training'})).toBeTruthy();
});
