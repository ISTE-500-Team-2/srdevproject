// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {ReservationsPage} from './ReservationsPage';
import {api,ApiError} from '../lib/api';
vi.mock('../context/AuthContext',()=>({useAuth:()=>({user:{id:1,roles:['member'],membership:'Monthly'}})}));
vi.mock('../lib/api',async original=>({...await original<typeof import('../lib/api')>(),api:vi.fn()}));
const machine={id:4,name:'3D Printer',type:'3D printing',rate:7,image:'/assets/3d-printer.webp',status:'available',canReserve:true,trainingRequired:false,availability:'Choose a time to check availability',location:'Makerspace'};
let records:Record<string,unknown>[];
beforeEach(()=>{
 records=[];
 Element.prototype.scrollIntoView=vi.fn();
 vi.mocked(api).mockImplementation(async(path,options)=>{
  if(options?.method) return {id:8,userId:1} as never;
  if(path==='/equipment')return [machine,{...machine,id:5,name:'Wood Lathe',type:'Wood turning'}] as never;
  if(path==='/reservations')return records as never;
  return {studios:[],timeZone:'America/New_York'} as never;
 });
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
async function mount(){await act(async()=>{render(<MemoryRouter><ReservationsPage/></MemoryRouter>);});}
async function open(){await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/^3D Printer 3D printing/}));});
 fireEvent.change(screen.getByLabelText(/Start date and time/),{target:{value:'2030-05-20T14:00'}});
}
const submits=()=>vi.mocked(api).mock.calls.filter(([p,o])=>p==='/reservations'&&o?.method==='POST');
test('equipment search matches name or type and links straight to saved bookings',async()=>{
 await mount();
 fireEvent.change(screen.getByRole('searchbox',{name:'Find equipment'}),{target:{value:'WOOD'}});
 expect(screen.getByRole('button',{name:/Wood Lathe/})).toBeTruthy();
 expect(screen.queryByRole('button',{name:/^3D Printer/})).toBeNull();
 fireEvent.click(screen.getByRole('link',{name:'My reservations'}));
 expect(document.activeElement).toBe(screen.getByRole('heading',{name:'My reservations'}));
 expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('WOOD');
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'no such machine'}});
 expect(screen.getByText('No equipment matches this filter.')).toBeTruthy();
});
test('same-tick repeated form submits send one booking request and release the lock after failure',async()=>{
 await mount();await open();
 let reject!:(error:Error)=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
 const form=screen.getByRole('button',{name:'Confirm reservation'}).closest('form')!;
 act(()=>{fireEvent.submit(form);fireEvent.submit(form);});
 expect(submits()).toHaveLength(1);
 expect((screen.getByRole('button',{name:'Saving…'}) as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>{reject(new ApiError(409,'RESERVATION_CONFLICT','Conflict'));});
 expect(screen.getByRole('alert').textContent).toContain('Choose another start time or shorten the duration');
 expect(document.activeElement).toBe(screen.getByRole('alert'));
 expect((screen.getByLabelText(/Start date and time/) as HTMLInputElement).value).toBe('2030-05-20T14:00');
 fireEvent.change(screen.getByLabelText(/Start date and time/),{target:{value:'2030-05-20T17:00'}});
 expect(screen.queryByRole('alert')).toBeNull();
 await act(async()=>{fireEvent.submit(form);});
 expect(submits()).toHaveLength(2);
 expect(screen.queryByRole('dialog')).toBeNull();
});
test('opening another booking clears the old success toast so it cannot cover the form',async()=>{
 await mount();await open();
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Confirm reservation'}).closest('form')!);});
 expect(screen.getByText('Reservation saved for 3D Printer.')).toBeTruthy();
 await open();
 expect(screen.queryByText('Reservation saved for 3D Printer.')).toBeNull();
});
test('cancellation cutoff is explained and only bookings outside it have a cancel action',async()=>{
 const start=Date.now()+2*3600000;
 records=[{id:1,equipmentName:'Soon',startTime:new Date(start).toISOString(),endTime:new Date(start+3600000).toISOString(),status:'confirmed'},
 {id:2,equipmentName:'Later',startTime:new Date(start+3*86400000).toISOString(),endTime:new Date(start+3*86400000+3600000).toISOString(),status:'confirmed'}];
 await mount();
 const soon=screen.getByRole('heading',{name:'Soon'}).closest('article')!;
 expect(within(soon).queryByRole('button')).toBeNull();
 expect(within(soon).getByText('Online cancellation closes 24 hours before the start time.')).toBeTruthy();
 const later=screen.getByRole('heading',{name:'Later'}).closest('article')!;
 let done!:()=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise(resolve=>{done=()=>resolve(undefined as never);}));
 const button=within(later).getByRole('button',{name:'Cancel reservation'});
 act(()=>{fireEvent.click(button);fireEvent.click(button);});
 expect(vi.mocked(api).mock.calls.filter(([p])=>p==='/reservations/2/cancel')).toHaveLength(1);
 await act(async()=>{done();});
 expect(screen.getByText('Reservation cancelled.')).toBeTruthy();
});

test('past start time is explained without sending a booking and keeps the input for correction',async()=>{
 await mount();await open();
 fireEvent.change(screen.getByLabelText(/Start date and time/),{target:{value:'2020-01-01T10:00'}});
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Confirm reservation'}).closest('form')!);});
 expect(submits()).toHaveLength(0);
 expect(screen.getByRole('alert').textContent).toBe('Choose a start time in the future.');
 expect((screen.getByLabelText(/Start date and time/) as HTMLInputElement).value).toBe('2020-01-01T10:00');
});
