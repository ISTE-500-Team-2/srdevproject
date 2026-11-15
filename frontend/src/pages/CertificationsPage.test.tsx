// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CertificationsPage } from './CertificationsPage';
const { api, reload, state } = vi.hoisted(() => ({
 api:vi.fn(),reload:vi.fn(),
 state: {
  data: {} as Record<string, any[]>,
  errors: {} as Record<string, string>,
  auth: { demoLogin: false, user: null as any },
 },
}));
vi.mock('../lib/api',()=>({api,errorMessage:(error:Error)=>error.message}));
vi.mock('../lib/useApi', () => ({ useApi: (path:string) => ({data:state.errors[path] ? null : state.data[path] ?? [],loading:false,error:state.errors[path] ?? '',reload}) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => state.auth }));
afterEach(()=>{cleanup();vi.clearAllMocks();state.errors={};});

const member = {role:'member',roles:['member'],email:'member@example.com'};
const inDays = (days:number) => new Date(Date.now()+days*86400000).toISOString();
const waiver = (overrides:object = {}) => ({id:2,versionId:2,name:'Shop policy',version:'v2',description:'Policy text',signed:false,signedAt:null,signedVersion:'v2',signedVersionId:2,outdatedSignature:false,expiredSignature:true,...overrides});
const cnc = {id:7,name:'Joey',type:'Large CNC',status:'available',certification:'CNC Training',canReserve:false,trainingRequired:true};
const lathe = {id:8,name:'Kirk',type:'Metal lathe',status:'available',certification:'Metal Lathe Training',canReserve:false,trainingRequired:true};
const printer = {id:1,name:'Rachel',type:'3D printer',status:'available',certification:null,canReserve:true,trainingRequired:false};
const klass = (overrides:object = {}) => ({id:30,title:'CNC Basics',certificationId:2,certificationName:'CNC Training',instructorId:5,instructor:'Sam Lee',capacity:8,enrolled:5,status:'scheduled',revision:1,roomId:1,roomName:'Maker room',startsAt:inDays(5),endsAt:inDays(5.05),myStatus:null,...overrides});

function mount({
 waivers = [waiver()],
 certifications = [] as object[],
 equipment = [] as object[],
 classes = [] as object[],
 user = member as any,
}: {waivers?:object[];certifications?:object[];equipment?:object[];classes?:object[];user?:any} = {}) {
 state.data={'/me/waivers':waivers,'/me/certifications':certifications,'/equipment':equipment,'/classes':classes};
 state.auth={demoLogin:false,user};
 render(<MemoryRouter><CertificationsPage /></MemoryRouter>);
}
const row = (name:string) => screen.getByRole('heading',{name}).closest('li')!;

test('expired current signature shows expiration and correct history, not a new version',()=>{
 mount();
 expect(screen.getByText(/Your signature has expired/).textContent).toContain('Last signed: v2');
 expect(screen.queryByText(/New version needs/)).toBeNull();
 expect(screen.getByText('Signature expired')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Review and agree'})).toBeTruthy();
});

test('superseded signature shows the latest historical version even when expired',()=>{
 mount({waivers:[waiver({version:'v3',outdatedSignature:true,expiredSignature:false})]});
 expect(screen.getByText(/New version needs/).textContent).toContain('Last signed: v2');
 expect(screen.queryByText(/Your signature has expired/)).toBeNull();
 expect(screen.getByRole('button',{name:'Review new version'})).toBeTruthy();
});

test('waivers that need a signature come first with a count, signed ones show their date',()=>{
 mount({waivers:[
  waiver({id:1,name:'Shop waiver',signed:true,signedAt:'2026-02-03T12:00:00Z',expiredSignature:false}),
  waiver({id:3,name:'Safety policy',signedVersion:null,expiredSignature:false}),
 ]});
 const panel = screen.getByRole('region',{name:'Waivers & policies'});
 expect(within(panel).getByText('1 to sign')).toBeTruthy();
 expect(Array.from(panel.querySelectorAll('.waiver-row h3')).map(h=>h.textContent)).toEqual(['Safety policy','Shop waiver']);
 const signed = row('Shop waiver');
 expect(within(signed).getByText('Signed')).toBeTruthy();
 expect(within(signed).getByText(/Feb 3, 2026/)).toBeTruthy();
 expect(within(signed).getByRole('button',{name:'View policy'})).toBeTruthy();
 const todo = row('Safety policy');
 expect(within(todo).getByText('Needs signature')).toBeTruthy();
 expect(within(todo).getByRole('button',{name:'Review and agree'}).className).toContain('button--primary');
});

test('signed waivers show when they run out and warn in the last 30 days; expired ones show when',()=>{
 mount({waivers:[
  waiver({id:1,name:'Shop waiver',signed:true,signedAt:'2026-02-03T12:00:00Z',expiresAt:inDays(200),expiredSignature:false}),
  waiver({id:3,name:'Laser waiver',signed:true,signedAt:'2026-02-03T12:00:00Z',expiresAt:inDays(10),expiredSignature:false}),
  waiver({id:4,name:'CNC waiver',expiresAt:'2026-10-30T12:00:00Z'}),
 ]});
 const ok = row('Shop waiver');
 expect(within(ok).getByText(/^Valid until /).className).toContain('status-pill--ok');
 expect(within(ok).getByText(/Signed .*Feb 3, 2026/)).toBeTruthy();
 expect(within(row('Laser waiver')).getByText(/^Expires /).className).toContain('status-pill--warn');
 const expired = row('CNC waiver');
 expect(within(expired).getByText(/^Expired .*Oct 30, 2026/)).toBeTruthy();
 expect(within(expired).getByText('Version v2')).toBeTruthy();
 expect(within(expired).getByText(/Last signed: v2/)).toBeTruthy();
});

test('all signed waivers say so and link to signed form copies',()=>{
 mount({waivers:[waiver({signed:true,signedAt:'2026-02-03T12:00:00Z',expiredSignature:false,formFields:[{key:'name'}]})]});
 expect(screen.getByText('All signed')).toBeTruthy();
 expect(screen.getByRole('link',{name:/Download signed copies/}).getAttribute('href')).toBe('/profile');
});

test('terms require acceptance before submission and record the completed agreement',async()=>{
 mount({waivers:[waiver({name:'Terms of Service',version:'2026-09-28',description:'Terms text',expiredSignature:false})]});
 fireEvent.click(screen.getByRole('button',{name:'Review and agree'}));
 const submit=screen.getByRole('button',{name:'Submit acceptance'}) as HTMLButtonElement;
 expect(submit.disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox',{name:'I have read and accept the Terms of Service.'}));
 expect(submit.disabled).toBe(false);
 api.mockResolvedValue({});
 fireEvent.click(submit);
 await waitFor(()=>expect(api).toHaveBeenCalledWith('/me/waivers/2/sign',{method:'POST',body:{accepted:true}}));
 expect(reload).toHaveBeenCalled();
 expect(await screen.findByText('Terms of Service completed.')).toBeTruthy();
});

test('accepted terms are marked completed and can be reviewed',()=>{
 mount({waivers:[waiver({name:'Terms of Service',signed:true,signedAt:'2026-10-22T12:00:00Z',expiredSignature:false})]});
 expect(screen.getByText('Completed')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'View policy'}));
 expect(screen.getByText('Terms of Service completed.')).toBeTruthy();
});

test('a failed signature keeps the policy open and shows the error',async()=>{
 mount({waivers:[waiver({expiredSignature:false})]});
 fireEvent.click(screen.getByRole('button',{name:'Review and agree'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'I have read and agree to this version of the policy.'}));
 api.mockRejectedValue(new Error('Policy changed'));
 fireEvent.click(screen.getByRole('button',{name:'Record agreement'}));
 expect(await screen.findByText('Policy changed')).toBeTruthy();
 expect(screen.getByRole('dialog')).toBeTruthy();
});

test('a current certification lists what it unlocks, who approved it and when it renews',()=>{
 mount({
  certifications:[{id:2,name:'CNC Training',status:'active',valid:true,renewalDate:inDays(200),trainedAt:'2026-10-01T15:00:00Z',instructorName:'Sam Lee',equipmentIds:[7,9]}],
  equipment:[cnc,{...cnc,id:9,name:'Ross'}],
 });
 const cert = row('CNC Training');
 expect(within(cert).getByText('Current')).toBeTruthy();
 expect(within(cert).getByText('Joey · Ross')).toBeTruthy();
 expect(within(cert).getByText(/Approved by Sam Lee · Trained .*Oct 1, 2026 · Renews/)).toBeTruthy();
 expect(within(cert).getByRole('link',{name:'Book equipment'}).getAttribute('href')).toBe('/equipment');
 expect(within(cert).queryByText(/Next class/)).toBeNull();
 expect(screen.getByText('1 of 1 current')).toBeTruthy();
});

test('an expiring certification points to a refresher class',()=>{
 mount({
  certifications:[{id:2,name:'CNC Training',status:'active',valid:true,renewalDate:inDays(10),equipmentIds:[7]}],
  equipment:[cnc],classes:[klass()],
 });
 const cert = row('CNC Training');
 expect(within(cert).getByText('Expires soon')).toBeTruthy();
 expect(within(cert).getByText('Refresher class')).toBeTruthy();
});

test('an expired certification comes first and links to the next matching class',()=>{
 mount({
  certifications:[
   {id:1,name:'Wood Lathe Training',status:'active',valid:true,renewalDate:null,equipmentIds:[]},
   {id:2,name:'CNC Training',status:'active',valid:false,renewalDate:inDays(-3),equipmentIds:[7]},
  ],
  equipment:[cnc],
  classes:[klass({id:31,startsAt:inDays(20),endsAt:inDays(20.05),title:'CNC Later'}),klass(),klass({id:32,certificationId:9,certificationName:'Laser Training',title:'Laser'})],
 });
 const rows = Array.from(screen.getByRole('region',{name:'Your certifications'}).querySelectorAll('.cert-row h3')).map(h=>h.textContent);
 expect(rows).toEqual(['CNC Training','Wood Lathe Training']);
 const cert = row('CNC Training');
 expect(within(cert).getByText('Expired')).toBeTruthy();
 expect(within(cert).getByText(/^Expired /)).toBeTruthy();
 expect(within(cert).getByText('CNC Basics')).toBeTruthy();
 expect(within(cert).getByText('3 seats left')).toBeTruthy();
 const link = within(cert).getByRole('link',{name:'Register for CNC Basics on Classes'});
 expect(link.getAttribute('href')).toBe('/classes');
 expect(within(row('Wood Lathe Training')).getByText(/No renewal needed/)).toBeTruthy();
 expect(screen.getByText('1 of 2 current')).toBeTruthy();
});

test('two certifications with the same name but different ids stay separate',()=>{
 mount({
  certifications:[{id:2,name:'CNC Training',status:'active',valid:true,renewalDate:inDays(200),equipmentIds:[]}],
  // Equipment carries the certification id, so each machine joins its own certification.
  equipment:[{...cnc,certId:2},{...cnc,id:9,name:'Ross',certId:5}],
  classes:[klass({certificationId:5,title:'CNC for the new router'})],
 });
 const [held, earn] = screen.getAllByRole('heading',{name:'CNC Training'}).map(h=>h.closest('li')!);
 expect(screen.getByRole('region',{name:'Your certifications'}).contains(held)).toBe(true);
 expect(within(held).getByText('Current')).toBeTruthy();
 expect(within(held).getByText('Joey')).toBeTruthy();
 expect(within(held).queryByText(/Ross/)).toBeNull();
 expect(within(held).queryByText('CNC for the new router')).toBeNull();
 expect(screen.getByRole('region',{name:'Earn a certification'}).contains(earn)).toBe(true);
 expect(within(earn).getByText('Not yet')).toBeTruthy();
 expect(within(earn).getByText('Ross')).toBeTruthy();
 expect(within(earn).getByText('CNC for the new router')).toBeTruthy();
});

test('revoked certifications are flagged for retraining',()=>{
 mount({certifications:[{id:2,name:'CNC Training',status:'revoked',valid:false,renewalDate:inDays(100),equipmentIds:[]}]});
 const cert = row('CNC Training');
 expect(within(cert).getByText('Revoked')).toBeTruthy();
 expect(within(cert).getByText(/Retraining needed/)).toBeTruthy();
 expect(within(cert).getByText('No class scheduled yet')).toBeTruthy();
});

test('certifications you do not hold yet come from equipment and show their next class',()=>{
 mount({equipment:[cnc,lathe,printer],classes:[klass({enrolled:8})]});
 expect(screen.getByText('No certifications yet')).toBeTruthy();
 const earn = screen.getByRole('region',{name:'Earn a certification'});
 expect(Array.from(earn.querySelectorAll('.cert-row h3')).map(h=>h.textContent)).toEqual(['CNC Training','Metal Lathe Training']);
 const cert = row('CNC Training');
 expect(within(cert).getByText('Not yet')).toBeTruthy();
 expect(within(cert).getByText('Joey')).toBeTruthy();
 expect(within(cert).getByText('Full')).toBeTruthy();
 expect(within(cert).getByRole('link',{name:'See other classes for CNC Basics on Classes'})).toBeTruthy();
 expect(within(row('Metal Lathe Training')).getByText('No class scheduled yet')).toBeTruthy();
 expect(screen.getByText('Rachel')).toBeTruthy();
 expect(screen.getByText('No certification needed:')).toBeTruthy();
});

test('registration and completed training show progress instead of a register button',()=>{
 mount({
  equipment:[cnc,lathe],
  classes:[
   klass({myStatus:'enrolled'}),
   klass({id:40,certificationId:3,certificationName:'Metal Lathe Training',title:'Lathe Safety',startsAt:inDays(-2),endsAt:inDays(-1.95),myStatus:'attended'}),
  ],
 });
 const registered = row('CNC Training');
 expect(within(registered).getByText('Registered')).toBeTruthy();
 expect(within(registered).getByText("You're registered")).toBeTruthy();
 expect(within(registered).getByRole('link',{name:'View CNC Basics on Classes'})).toBeTruthy();
 const awaiting = row('Metal Lathe Training');
 expect(within(awaiting).getByText('Awaiting approval')).toBeTruthy();
 expect(within(awaiting).getByText(/approves your certification in person/)).toBeTruthy();
 expect(within(awaiting).queryByRole('link')).toBeNull();
});

test('a class load failure still shows certifications and offers a retry',()=>{
 state.errors={'/classes':'Classes unavailable'};
 mount({certifications:[{id:2,name:'CNC Training',status:'active',valid:true,renewalDate:null,equipmentIds:[]}]});
 expect(screen.getByRole('alert').textContent).toContain('Classes unavailable');
 fireEvent.click(within(screen.getByRole('alert')).getByRole('button',{name:'Retry'}));
 expect(reload).toHaveBeenCalled();
 expect(row('CNC Training')).toBeTruthy();
});

test('with nothing to certify the page shows a designed empty state',()=>{
 mount({waivers:[]});
 expect(screen.getByRole('heading',{name:'No certifications needed yet'})).toBeTruthy();
 expect(screen.getByText('Nothing to sign right now.')).toBeTruthy();
});

test('only staff and instructors get the training records link',()=>{
 mount();
 expect(screen.queryByRole('link',{name:'Manage training records'})).toBeNull();
 cleanup();
 mount({user:{role:'instructor',roles:['instructor'],email:'i@example.com'}});
 expect(screen.getByRole('link',{name:'Manage training records'}).getAttribute('href')).toBe('/training');
});
