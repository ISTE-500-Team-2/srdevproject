// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {EquipmentPage} from './EquipmentPage';
import {api,ApiError} from '../lib/api';
import type {EquipmentPrice,LiveEquipment,Reservation} from '../lib/contracts';
import {mockApi,mockApiOnce} from '../testing/apiMock';
import {liveEquipment,reservation} from '../testing/fixtures';
vi.mock('../context/AuthContext',()=>({useAuth:()=>({user:{id:1,roles:['member'],membership:'Monthly'}})}));
vi.mock('../lib/api',async original=>({...await original<typeof import('../lib/api')>(),api:vi.fn()}));
const machine=liveEquipment({id:4,name:'3D Printer',type:'3D printing',rate:7,image:'/assets/3d-printer.webp',status:'available',canReserve:true,trainingRequired:false,availability:'Choose a time to check availability',location:'Makerspace'});
function quoteFor(path:string,items=[machine]):EquipmentPrice|null{
 const match=/\/equipment\/(\d+)\/quote\?hours=(\d+)/.exec(path);
 if(!match)return null;
 const selected=items.find(item=>item.id===Number(match[1]));
 if(!selected||selected.rate==null)return null;
 const hours=Number(match[2]),hourlyRateCents=Math.round(selected.rate*100),equipmentCents=hourlyRateCents*hours;
 return {currency:'USD',hours,hourlyRateCents,equipmentCents,trainingFeeCents:0,totalCents:equipmentCents,certificationId:null,certificationRevision:null};
}
let records:Reservation[];
beforeEach(()=>{
 records=[];
 Element.prototype.scrollIntoView=vi.fn();
 mockApi(async(path,options)=>{
  if(options?.method) return reservation({id:8,userId:1,status:'confirmed'});
  if(path==='/equipment')return [machine,{...machine,id:5,name:'Wood Lathe',type:'Wood turning'}];
  if(path==='/reservations')return records;
    if(path.includes('/quote?'))return quoteFor(path);
  return unexpected(path);
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
/** Every request a test does not route fails loudly instead of receiving a made-up reply. */
function unexpected(path:string):never{throw new Error('Unexpected request '+path);}
const submits=()=>vi.mocked(api).mock.calls.filter(([p,o])=>p==='/reservations'&&o?.method==='POST');

test('reviews hourly equipment charges without adding the configured training fee',async()=>{
 mockApi(async(path,options)=>{
  // An unconfirmed reply: the page reports payment pending rather than a booking.
  if(options?.method)return reservation({id:8,userId:1,status:'pending'});
  if(path==='/equipment')return [{...machine,trainingFeeCents:2000,trainingMinutes:60}];
  if(path==='/reservations')return [];
  if(path.includes('/quote?')){const hours=Number(path.split('hours=')[1]);return {currency:'USD',hours,hourlyRateCents:700,equipmentCents:hours*700,trainingFeeCents:0,totalCents:hours*700,certificationId:9,certificationRevision:1} satisfies EquipmentPrice;}
  return unexpected(path);
 });
 await mount();await open();
 fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'2'}});
 const breakdown=await screen.findByRole('region',{name:'Booking price breakdown'});
 await waitFor(()=>expect(within(breakdown).getAllByText('$14.00')).toHaveLength(2));
 expect(within(breakdown).queryByText('$20.00')).toBeNull();
 expect(screen.queryByText(/fee on every booking/)).toBeNull();
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 expect(submits()[0]![1]!.body).toMatchObject({expectedPrice:{hours:2,equipmentCents:1400,trainingFeeCents:0,totalCents:1400}});
});
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
 records=[reservation({id:1,equipmentName:'Soon',startTime:new Date(start).toISOString(),endTime:new Date(start+3600000).toISOString(),status:'confirmed'}),
 reservation({id:2,equipmentName:'Later',startTime:new Date(start+3*86400000).toISOString(),endTime:new Date(start+3*86400000+3600000).toISOString(),status:'confirmed'})];
 await mount();
 const soon=screen.getByRole('heading',{name:'Soon'}).closest('article')!;
 expect(within(soon).queryByRole('button')).toBeNull();
 expect(within(soon).getByText('Online cancellation closes 24 hours before the start time.')).toBeTruthy();
 const later=screen.getByRole('heading',{name:'Later'}).closest('article')!;
 let done!:()=>void;
 mockApiOnce(()=>new Promise(resolve=>{done=()=>resolve(undefined);}));
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
 // A fresh list per request, as the server sends.
 const catalog=():LiveEquipment[]=>[
  {...machine,id:11,name:'Rachel',type:'3D printer'},
  {...machine,id:12,name:'Phoebe',type:'3D printer',rate:9,trainingRequired:true,canReserve:false,availability:'Training and waiver required'},
  {...machine,id:13,name:'Monica',type:'3D printer'},
  {...machine,id:14,name:'Kirk',type:'Metal lathe'},
  {...machine,id:15,name:'Spock',type:'Wood lathe'},
 ];
 mockApi(async(path,options)=>{
  if(options?.method) return reservation({id:8,userId:1,status:'confirmed'});
  if(path==='/equipment') return catalog();
    if(path.includes('/quote?'))return quoteFor(path,catalog());
  if(path==='/reservations') return [];
  return unexpected(path);
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
 expect(submits()).toHaveLength(0);
 expect((screen.getByRole('button',{name:/confirm reservation/i}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('radio',{name:/Monica/}));
 await waitFor(()=>expect((screen.getByRole('button',{name:/confirm reservation/i}) as HTMLButtonElement).disabled).toBe(false));
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 expect((submits()[0]![1]!.body as {equipmentId:number}).equipmentId).toBe(13);
 fireEvent.change(screen.getByRole('combobox',{name:'Equipment filter'}),{target:{value:'ready'}});
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).not.toContain('Phoebe');
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Monica'}});
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).toContain('Monica');
 expect(screen.getByRole('button',{name:/^3D Printer/}).textContent).not.toContain('Rachel');
});


test('charges the displayed hourly price times duration and redirects before confirmation', async()=>{
 await mount();await open();
 await screen.findByRole('region',{name:'Booking price breakdown'});
 const assign=vi.fn();
 vi.stubGlobal('location',{assign});
 fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'2'}});
 await waitFor(()=>expect(within(screen.getByRole('region',{name:'Booking price breakdown'})).getAllByText('$14.00')).toHaveLength(2));
 expect(screen.getByText('Continue to secure checkout. Your reservation is confirmed after payment succeeds.')).toBeTruthy();
 expect(screen.queryByText(/Payment is recorded at the front desk/)).toBeNull();
 expect(screen.getByRole('button',{name:'Pay $14.00 & confirm reservation'})).toBeTruthy();
 mockApiOnce(async()=>reservation({id:8,status:'pending',checkoutUrl:'https://checkout.stripe.com/test-equipment'}));
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Pay $14.00 & confirm reservation'}).closest('form')!);});
 expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/test-equipment');
 expect((submits()[0][1]!.body as {amountCents:number}).amountCents).toBe(1400);
 expect(screen.queryByText('Reservation confirmed for 3D Printer.')).toBeNull();
});

test('return parameters alone do not claim payment succeeded; pending checkout can be resumed or cancelled',async()=>{
 const start=Date.now()+3*86400000;
 records=[reservation({id:8,userId:1,payerId:1,equipmentName:'3D Printer',startTime:new Date(start).toISOString(),endTime:new Date(start+3600000).toISOString(),status:'pending',paymentStatus:'pending',amountCents:700})];
 await act(async()=>{render(<MemoryRouter initialEntries={['/equipment?payment=returned&reservation=8']}><EquipmentPage/></MemoryRouter>);});
 expect(screen.getByText(/Checking your payment/)).toBeTruthy();
 expect(screen.queryByText('Payment received. Your reservation is confirmed.')).toBeNull();
 expect(screen.getByRole('button',{name:'Pay $7.00'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Cancel reservation'})).toBeNull();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel checkout'}));});
 expect(vi.mocked(api).mock.calls.some(([path])=>path==='/reservations/8/cancel-checkout')).toBe(true);
});

test('missing equipment rate prevents checkout',async()=>{
 mockApi(async(path)=>path==='/equipment'?[{...machine,rate:null}]:path.includes('/quote?')?null:path==='/reservations'?[]:unexpected(path));
 await mount();await open();
 await waitFor(()=>expect((screen.getByRole('button',{name:'Confirm reservation'}) as HTMLButtonElement).disabled).toBe(true));
 expect((screen.getByRole('button',{name:'Confirm reservation'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/Rate not set. Contact staff/)).toBeTruthy();
});


test('missing required waivers disable payment and block programmatic form submission',async()=>{
 mockApi(async(path)=>path==='/equipment'?[{...machine,waiverRequired:true,canReserve:false,availability:'Signed waivers required'}]:path.includes('/quote?')?quoteFor(path):path==='/reservations'?[]:unexpected(path));
 await mount();await open();
 const pay=screen.getByRole('button',{name:'Pay $7.00 & confirm reservation'});
 expect((pay as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('link',{name:'Review your waivers and certifications'}).getAttribute('href')).toBe('/certifications');
 await act(async()=>{fireEvent.submit(pay.closest('form')!);});
 expect(submits()).toHaveLength(0);
 expect(screen.getByRole('alert').textContent).toContain('Signed waivers required');
});

test('live waiver eligibility changes disable payment even when the selected machine object is stale',async()=>{
 await mount();await open();
 mockApi(async(path)=>path==='/equipment'?[{...machine,waiverRequired:true,canReserve:false,availability:'Signed waivers required'}]:path.includes('/quote?')?quoteFor(path):path==='/reservations'?[]:unexpected(path));
 await act(async()=>{window.dispatchEvent(new Event('focus'));});
 expect((screen.getByRole('button',{name:'Pay $7.00 & confirm reservation'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('link',{name:'Review your waivers and certifications'})).toBeTruthy();
});

test('pending checkout cannot be resumed while its owner needs to sign required waivers',async()=>{
 const start=Date.now()+3*86400000;
 records=[reservation({id:8,equipmentId:4,userId:1,payerId:1,equipmentName:'3D Printer',startTime:new Date(start).toISOString(),endTime:new Date(start+3600000).toISOString(),status:'pending',paymentStatus:'pending',amountCents:700})];
 mockApi(async(path)=>path==='/equipment'?[{...machine,waiverRequired:true,canReserve:false,availability:'Signed waivers required'}]:path==='/reservations'?records:unexpected(path));
 await mount();
 expect((screen.getByRole('button',{name:'Pay $7.00'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('link',{name:'Review your waivers and certifications'})).toBeTruthy();
 expect((screen.getByRole('button',{name:'Cancel checkout'}) as HTMLButtonElement).disabled).toBe(false);
});

test('reservations split into upcoming and past, with cancelled and expired bookings behind a toggle',async()=>{
 const hour=3600000,now=Date.now(),at=(offset:number)=>new Date(now+offset).toISOString();
 const row=(id:number,name:string,start:number,extra:Partial<Reservation>={})=>reservation({id,userId:1,equipmentId:4,equipmentName:name,location:'Makerspace',startTime:at(start),endTime:at(start+hour),status:'confirmed',...extra});
 records=[
  row(1,'Ended paid',-50*hour,{paymentStatus:'paid',amountCents:700}),
  row(2,'Later',72*hour,{paymentStatus:'paid',amountCents:700}),
  row(3,'Running',-hour/2,{paymentStatus:'paid'}),
  row(4,'Pay me',96*hour,{status:'pending',paymentStatus:'pending',payerId:1,amountCents:1400,priceSnapshot:{currency:'USD',hours:2,hourlyRateCents:700,equipmentCents:700,trainingFeeCents:700,totalCents:1400,certificationId:9,certificationRevision:1}}),
  row(5,'Expired checkout',-30*hour,{status:'cancelled',paymentStatus:'expired'}),
  row(6,'Front desk',48*hour,{status:'pending',paymentStatus:'pending',payerId:null}),
  row(7,'For a member',120*hour,{userId:2,memberName:'Dana Whitfield',paymentStatus:'paid'}),
  row(8,'Wood Shop',150*hour,{equipmentId:null,resourceType:'room',location:'Instructor-led training'}),
 ];
 await mount();
 const mine=screen.getByRole('region',{name:'My reservations'});
 const names=()=>within(mine).getAllByRole('heading',{level:3}).map(h=>h.textContent);
 // The member's own payment comes first, then soonest first; ended bookings follow, newest first.
 expect(names()).toEqual(['Upcoming · 6','Pay me','Running','Front desk','Later','For a member','Wood Shop','Past · 1','Ended paid']);
 const card=(name:string)=>within(mine).getByRole('heading',{name}).closest('article')!;
 expect(within(card('Pay me')).getByText('Awaiting payment')).toBeTruthy();
 expect(within(card('Pay me')).getByText('incl. $7.00 training')).toBeTruthy();
 expect(within(card('Pay me')).getByRole('button',{name:'Pay $14.00'})).toBeTruthy();
 expect(within(card('Running')).getByText('In progress')).toBeTruthy();
 expect(within(card('Running')).queryByRole('button')).toBeNull();
 expect(within(card('Front desk')).getByText('Payment due at front desk')).toBeTruthy();
 expect(within(card('Front desk')).getByRole('button',{name:'Cancel reservation'})).toBeTruthy();
 expect(within(card('Later')).getByText('Confirmed · Paid')).toBeTruthy();
 expect(within(card('Later')).getByText('3D Printer · Makerspace')).toBeTruthy();
 expect(within(card('For a member')).getByText('For Dana Whitfield')).toBeTruthy();
 expect(within(card('Wood Shop')).getByText('Studio · Instructor-led training')).toBeTruthy();
 expect(within(card('Ended paid')).getByText('Ended · Paid')).toBeTruthy();
 expect(within(card('Ended paid')).queryByText(/online cancellation/i)).toBeNull();
 expect(within(mine).queryByRole('heading',{name:'Expired checkout'})).toBeNull();
 const toggle=within(mine).getByLabelText(/Show cancelled/);expect(toggle.closest("label")!.textContent).toBe("Show cancelled and expired (1)");fireEvent.click(toggle);
 expect(within(card('Expired checkout')).getByText('Checkout expired')).toBeTruthy();
 fireEvent.click(within(mine).getByRole('button',{name:'Past · 1'}));
 expect(within(mine).queryByRole('heading',{name:'Ended paid'})).toBeNull();
});
test('cancelled bookings keep whether they were paid or refunded',async()=>{
 const at=(offset:number)=>new Date(Date.now()+offset).toISOString();
 const row=(id:number,name:string,paymentStatus:string)=>reservation({id,userId:1,equipmentId:4,equipmentName:name,location:'Makerspace',startTime:at(-48*3600000),endTime:at(-47*3600000),status:'cancelled',paymentStatus,amountCents:700});
 records=[row(1,'Kept payment','paid'),row(2,'Money back','refunded'),row(3,'Never paid','pending')];
 await mount();
 const mine=screen.getByRole('region',{name:'My reservations'});
 fireEvent.click(within(mine).getByLabelText(/Show cancelled/));
 const card=(name:string)=>within(mine).getByRole('heading',{name}).closest('article')!;
 expect(within(card('Kept payment')).getByText('Cancelled · Paid')).toBeTruthy();
 expect(within(card('Money back')).getByText('Cancelled · Refunded')).toBeTruthy();
 expect(within(card('Never paid')).getByText('Cancelled')).toBeTruthy();
});
test('equipment and reservations show placeholders in their own shape while they load',async()=>{
 let catalog!:(items:LiveEquipment[])=>void,saved!:(items:Reservation[])=>void;
 mockApi(path=>path==='/equipment'?new Promise<LiveEquipment[]>(resolve=>{catalog=resolve;})
  :path==='/reservations'?new Promise<Reservation[]>(resolve=>{saved=resolve;}):Promise.reject(new Error('Unexpected request '+path)));
 await mount();
 expect(screen.getByRole('status',{name:'Loading equipment'})).toBeTruthy();
 expect(screen.getByRole('status',{name:'Loading reservations'})).toBeTruthy();
 expect(screen.queryByText(/Loading (equipment|reservations)…/)).toBeNull();
 // The placeholders are hidden from screen readers: no stray headings or buttons.
 expect(within(screen.getByRole('region',{name:'My reservations'})).queryAllByRole('heading',{level:3})).toHaveLength(0);
 expect(screen.queryByRole('button',{name:/3D Printer/})).toBeNull();
 await act(async()=>{catalog([machine]);saved([]);});
 expect(screen.queryByRole('status',{name:/Loading/})).toBeNull();
 expect(screen.getByRole('button',{name:/^3D Printer/})).toBeTruthy();
 expect(screen.getByText(/No reservations yet/)).toBeTruthy();
});
