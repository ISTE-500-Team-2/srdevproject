// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {EquipmentPage} from './EquipmentPage';
import {api,ApiError} from '../lib/api';
vi.mock('../context/AuthContext',()=>({useAuth:()=>({user:{id:1,roles:['member'],membership:'Monthly'}})}));
vi.mock('../lib/api',async original=>({...await original<typeof import('../lib/api')>(),api:vi.fn()}));
const machine={id:4,name:'3D Printer',type:'3D printing',rate:7,image:'/assets/3d-printer.webp',status:'available',canReserve:true,trainingRequired:false,availability:'Choose a time to check availability',location:'Makerspace'};
let records:Record<string,unknown>[];
beforeEach(()=>{
 records=[];
 Element.prototype.scrollIntoView=vi.fn();
 vi.mocked(api).mockImplementation(async(path,options)=>{
  if(options?.method) return {id:8,userId:1,status:'confirmed'} as never;
  if(path==='/equipment')return [machine,{...machine,id:5,name:'Wood Lathe',type:'Wood turning'}] as never;
  if(path==='/reservations')return records as never;
  return {studios:[],timeZone:'America/New_York'} as never;
 });
});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
async function mount(){await act(async()=>{render(<MemoryRouter><EquipmentPage/></MemoryRouter>);});}
const tomorrow=()=>{const d=new Date();d.setDate(d.getDate()+1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const startValue=()=>(document.querySelector('input[name="start"]') as HTMLInputElement).value;
const pickTime=(minutes:number)=>fireEvent.change(screen.getByLabelText('Start time'),{target:{value:`${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`}});
async function open(){await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/^3D Printer/}));});
 fireEvent.click(screen.getByRole('button',{name:new Date(tomorrow()+'T12:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}));
 pickTime(14*60);
}
const submits=()=>vi.mocked(api).mock.calls.filter(([p,o])=>p==='/reservations'&&o?.method==='POST');
test('equipment search matches name or type and links straight to saved bookings',async()=>{
 await mount();
 expect(screen.getByRole('heading',{name:/^Equipment$/})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'Studio Spaces'})).toBeNull();
 expect(vi.mocked(api).mock.calls.some(([path])=>path==='/studios')).toBe(false);
 fireEvent.change(screen.getByRole('searchbox',{name:'Find equipment'}),{target:{value:'WOOD'}});
 expect(screen.getByRole('button',{name:/Wood Lathe/})).toBeTruthy();
 expect(screen.queryByRole('button',{name:/^3D Printer/})).toBeNull();
 expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('WOOD');
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'no such machine'}});
 expect(screen.getByText('No equipment matches this filter.')).toBeTruthy();
});
test('same-tick repeated form submits send one booking request and release the lock after failure',async()=>{
 await mount();await open();
 let reject!:(error:Error)=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
 const form=screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!;
 act(()=>{fireEvent.submit(form);fireEvent.submit(form);});
 expect(submits()).toHaveLength(1);
 expect((screen.getByRole('button',{name:'Preparing checkout…'}) as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>{reject(new ApiError(409,'RESERVATION_CONFLICT','Conflict'));});
 expect(screen.getByRole('alert').textContent).toContain('Choose another start time or shorten the duration');
 expect(document.activeElement).toBe(screen.getByRole('alert'));
 expect(startValue()).toBe(tomorrow()+'T14:00');
 pickTime(17*60);
 expect(screen.queryByRole('alert')).toBeNull();
 await act(async()=>{fireEvent.submit(form);});
 expect(submits()).toHaveLength(2);
 expect(screen.queryByRole('dialog')).toBeNull();
});
test('opening another booking clears the old success toast so it cannot cover the form',async()=>{
 await mount();await open();
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 expect(screen.getByText('Reservation confirmed for 3D Printer.')).toBeTruthy();
 await open();
 expect(screen.queryByText('Reservation confirmed for 3D Printer.')).toBeNull();
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

test('the picked day and time are what gets booked',async()=>{
 await mount();await open();
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 const body=submits()[0]![1]!.body as {startTime:string;endTime:string};
 expect(body.startTime).toBe(new Date(tomorrow()+'T14:00').toISOString());
 expect(body.endTime).toBe(new Date(new Date(tomorrow()+'T14:00').getTime()+3600000).toISOString());
});


test('groups named printers while preserving per-machine prices, access and booking identity', async()=>{
 vi.mocked(api).mockImplementation(async(path,options)=>{
  if(options?.method) return {id:8,userId:1,status:'confirmed'} as never;
  if(path==='/equipment') return [
   {...machine,id:11,name:'Rachel',type:'3D printer'},
   {...machine,id:12,name:'Phoebe',type:'3D printer',rate:9,trainingRequired:true,canReserve:false,availability:'Training and waiver required'},
   {...machine,id:13,name:'Monica',type:'3D printer'},
   {...machine,id:14,name:'Kirk',type:'Metal lathe'},
   {...machine,id:15,name:'Spock',type:'Wood lathe'},
  ] as never;
  return [] as never;
 });
 await mount();
 expect(document.querySelectorAll('.equipment-card')).toHaveLength(2);
 const printers=screen.getByRole('button',{name:/^3D Printer/});
 expect(printers.textContent).toContain('Rachel \u00b7 Phoebe \u00b7 Monica');
 expect(printers.textContent).not.toContain('/hour');
 expect(within(printers).queryByRole('link')).toBeNull();
 await act(async()=>{fireEvent.click(printers);});
 const phoebe=screen.getByRole('radio',{name:/Phoebe/});
 expect(phoebe.closest('label')!.textContent).toContain('$9.00/hour');
 expect(phoebe.closest('label')!.textContent).toContain('Training and waiver required');
 fireEvent.click(phoebe);
 expect((phoebe as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:new Date(tomorrow()+'T12:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}));
 pickTime(14*60);
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 expect((submits()[0]![1]!.body as {equipmentId:number}).equipmentId).toBe(12);
 fireEvent.change(screen.getByRole('combobox',{name:'Equipment filter'}),{target:{value:'ready'}});
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).not.toContain('Phoebe');
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Monica'}});
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).toContain('Monica');
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).not.toContain('Rachel');
});


test('charges the displayed hourly price times duration and redirects before confirmation', async()=>{
 await mount();await open();
 const assign=vi.fn();
 vi.stubGlobal('location',{assign});
 fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'2'}});
 expect(screen.getByText('Total: $14.00')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Pay $14.00 & confirm reservation'})).toBeTruthy();
 vi.mocked(api).mockImplementationOnce(async()=>({id:8,status:'pending',checkoutUrl:'https://checkout.stripe.com/test-equipment'}) as never);
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Pay $14.00 & confirm reservation'}).closest('form')!);});
 expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/test-equipment');
 expect((submits()[0][1]!.body as {amountCents:number}).amountCents).toBe(1400);
 expect(screen.queryByText('Reservation confirmed for 3D Printer.')).toBeNull();
});

test('return parameters alone do not claim payment succeeded; pending checkout can be resumed or cancelled',async()=>{
 const start=Date.now()+3*86400000;
 records=[{id:8,userId:1,payerId:1,equipmentName:'3D Printer',startTime:new Date(start).toISOString(),endTime:new Date(start+3600000).toISOString(),status:'pending',paymentStatus:'pending',amountCents:700}];
 await act(async()=>{render(<MemoryRouter initialEntries={['/equipment?payment=returned&reservation=8']}><EquipmentPage/></MemoryRouter>);});
 expect(screen.getByText(/Checking your payment/)).toBeTruthy();
 expect(screen.queryByText('Payment received. Your reservation is confirmed.')).toBeNull();
 expect(screen.getByRole('button',{name:'Pay $7.00'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Cancel reservation'})).toBeNull();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel checkout'}));});
 expect(vi.mocked(api).mock.calls.some(([path])=>path==='/reservations/8/cancel-checkout')).toBe(true);
});

test('missing equipment rate prevents checkout',async()=>{
 vi.mocked(api).mockImplementation(async(path)=>path==='/equipment'?[{...machine,rate:null}] as never:[] as never);
 await mount();await open();
 expect((screen.getByRole('button',{name:'Confirm reservation'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/Rate not set. Contact staff/)).toBeTruthy();
});
