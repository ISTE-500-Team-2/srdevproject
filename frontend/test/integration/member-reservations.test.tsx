import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import App from '../../src/App';
import {createBrowserBridge} from '../../../backend/test/helpers/browserBridge';
let bridge:Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async()=>{bridge=await createBrowserBridge();},120000);
afterAll(async()=>{cleanup();vi.unstubAllGlobals();await bridge?.close();},30000);
// Picks a start in the day-and-time picker: the day button, then the time.
const pickStart=(scope:{getByRole:typeof screen.getByRole;getByLabelText:typeof screen.getByLabelText},d:Date)=>{
  fireEvent.click(scope.getByRole('radio',{name:d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}));
  fireEvent.change(scope.getByLabelText('Start time'),{target:{value:String(d.getHours()*60+d.getMinutes())}});
};

test('member finds equipment, books once, recovers from conflicts and cooldown, and cancels under existing rules',async()=>{
 Element.prototype.scrollIntoView=vi.fn();
 let creates=0;
 let releaseCatalog: (()=>void)|undefined;
 // Hold every post-booking catalog refresh open. Without this, a fast run can
 // click the pre-refresh card just before useApi removes it, never opening a dialog.
 const finishBooking = async()=>{
  await screen.findByText('Reservation saved for 3D Printer.');
  await screen.findByText('Loading equipment…');
  expect(screen.queryByRole('button',{name:/^3D Printer/})).toBeNull();
  expect(releaseCatalog).toBeTypeOf('function');
  releaseCatalog!();
  releaseCatalog=undefined;
  await screen.findByRole('button',{name:/^3D Printer/});
 };
 vi.stubGlobal('fetch',async(input:string,init:RequestInit={})=>{
  if(input==='/api/reservations'&&init.method==='POST')creates++;
  if(input==='/api/equipment'&&creates>0) await new Promise<void>(resolve=>{releaseCatalog=resolve;});
  return bridge.fetch(input,init);
 });
 expect((await bridge.fetch('/api/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'member'})})).status).toBe(200);
 render(<MemoryRouter initialEntries={['/reservations']}><App/></MemoryRouter>);
 const user=userEvent.setup();
 await user.type(await screen.findByRole('searchbox',{name:'Find equipment'}),'3d print');
 await user.click(await screen.findByRole('button',{name:/^3D Printer/}));
 const start=new Date(Date.now()+3*86400000);start.setHours(14,0,0,0);
 const local=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
 const choose=async(d:Date)=>{await screen.findByLabelText('Start time');pickStart(screen,d);};
 await choose(start);
 await user.selectOptions(screen.getByLabelText('Duration'),'2');
 const form=screen.getByRole('button',{name:'Confirm reservation'}).closest('form')!;
 fireEvent.submit(form);fireEvent.submit(form);
 await finishBooking();
 expect(creates).toBe(1);
 const initial=(await bridge.pool.query('SELECT reservationid,endtime-starttime AS duration FROM reservation')).rows;
 expect(initial).toHaveLength(1);expect(initial[0].duration.hours).toBe(2);
 await user.click(await screen.findByRole('button',{name:/^3D Printer/}));
 await choose(start);
 await user.click(screen.getByRole('button',{name:'Confirm reservation'}));
 const error=await screen.findByRole('alert');
 expect(error.textContent).toContain('Choose another start time or shorten the duration');
 expect((document.querySelector('input[name="start"]') as HTMLInputElement).value).toBe(local(start));
 expect((await bridge.pool.query('SELECT reservationid FROM reservation')).rowCount).toBe(1);
 const end=new Date(start.getTime()+2*3600000);
 await choose(end);
 await user.click(screen.getByRole('button',{name:'Confirm reservation'}));
 expect((await screen.findByRole('alert')).textContent).toContain('15 minutes');
 await choose(new Date(end.getTime()+15*60000));
 await user.click(screen.getByRole('button',{name:'Confirm reservation'}));
 await finishBooking();
 expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('3d print');
 const mine=screen.getByRole('region',{name:'My reservations'});
 await waitFor(()=>expect(within(mine).getAllByRole('button',{name:'Cancel reservation'})).toHaveLength(2));
 await user.click(within(mine).getAllByRole('button',{name:'Cancel reservation'})[0]);
 await screen.findByText('Reservation cancelled.');
 expect((await bridge.pool.query("SELECT reservationid FROM reservation WHERE status='cancelled'")).rowCount).toBe(1);
 // A booking less than 24h away remains non-cancellable in both UI and API.
 await user.click(screen.getByRole('button',{name:/^3D Printer/}));
 const soon=new Date(Date.now()+2*3600000);soon.setMinutes(0,0,0);await choose(soon);
 await user.click(screen.getByRole('button',{name:'Confirm reservation'}));
 await finishBooking();
 await screen.findByText('Online cancellation closes 24 hours before the start time.');
 const soonRow=(await bridge.pool.query("SELECT reservationid FROM reservation WHERE status='confirmed' ORDER BY reservationid DESC LIMIT 1")).rows[0];
 const csrf=await (await bridge.fetch('/api/auth/csrf')).json();
 const denied=await bridge.fetch(`/api/reservations/${soonRow.reservationid}/cancel`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.data.csrfToken},body:'{}'});
 expect(denied.status).toBe(409);
 expect((await denied.json()).error.code).toBe('CANCELLATION_NOTICE_REQUIRED');
});
