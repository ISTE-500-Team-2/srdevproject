// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CertificationsPage } from './CertificationsPage';
const { state } = vi.hoisted(() => ({
 state: {
  waivers: [] as any[],
  certifications: [] as any[],
  equipment: [] as any[],
  auth: { demoLogin: false, user: null as any },
 },
}));
vi.mock('../lib/useApi', () => ({ useApi: (path:string) => ({data:path === '/me/waivers' ? state.waivers : path === '/equipment' ? state.equipment : state.certifications,loading:false,error:null,reload:vi.fn()}) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => state.auth }));
afterEach(cleanup);
function mount(
 overrides:object,
 auth = state.auth,
 certifications:object[] = [],
 equipment:object[] = [],
 waivers?:object[],
) {
 state.waivers=waivers ?? [{id:2,versionId:2,name:'Shop policy',version:'v2',signed:false,signedAt:null,signedVersion:'v2',signedVersionId:2,outdatedSignature:false,expiredSignature:true,...overrides}];
 state.certifications=certifications;
 state.equipment=equipment;
 state.auth=auth;
 render(<MemoryRouter><CertificationsPage /></MemoryRouter>);
}
test('expired current signature shows expiration and correct history, not a new version',()=>{
 mount({});
 expect(screen.getByText(/Your signature has expired/).textContent).toContain('Last signed: v2');
 expect(screen.queryByText(/New version needs/)).toBeNull();
 expect(screen.getByRole('button',{name:'Review and agree'})).toBeTruthy();
});
test('superseded signature shows the latest historical version even when expired',()=>{
 mount({version:'v3',outdatedSignature:true,expiredSignature:false});
 expect(screen.getByText(/New version needs/).textContent).toContain('Last signed: v2');
 expect(screen.queryByText(/Your signature has expired/)).toBeNull();
 expect(screen.getByRole('button',{name:'Review new version'})).toBeTruthy();
});
test('member demo gets the reservations equipment heading styling',()=>{
 mount({}, {demoLogin:true,user:{role:'member',email:'demo.member@collaboratory.invalid'}});
 expect(document.querySelectorAll('.credentials-page--member-demo .certifications-heading')).toHaveLength(2);
});
test('member demo certifications are divided into the requested columns',()=>{
 mount(
  {},
  {demoLogin:true,user:{role:'member',email:'demo.member@collaboratory.invalid'}},
  [{id:1,name:'Laser Engraver',valid:true,status:'active',renewalDate:'2027-01-01'}],
  [
   {id:1,name:'Laser Engraver',certification:'Laser Engraver'},
   {id:2,name:'3D Printer',certification:null},
   {id:3,name:'Wood Lathe',certification:'Wood Lathe'},
  ],
 );
 expect(screen.getByRole('columnheader',{name:'Equipment name'})).toBeTruthy();
 expect(screen.getByRole('columnheader',{name:'Completion status'})).toBeTruthy();
 expect(screen.getByRole('columnheader',{name:'Date completed'})).toBeTruthy();
 expect(screen.getByText('Laser Engraver')).toBeTruthy();
 expect(screen.getByText('complete')).toBeTruthy();
 expect(screen.getByText('incomplete')).toBeTruthy();
 expect(screen.getByText('No completion needed')).toBeTruthy();
 expect(screen.getAllByText('MM/DD/YYYY')).toHaveLength(3);
 expect(document.querySelectorAll('.certification-date-placeholder--muted')).toHaveLength(3);
});
test('member demo policies are listed with signed status and signature date',()=>{
 mount(
  {},
  {demoLogin:true,user:{role:'member',email:'demo.member@collaboratory.invalid'}},
  [],
  [],
  [
   {id:1,versionId:1,name:'Shop waiver',version:'v1',signed:true,signedAt:'2026-02-03T12:00:00Z',signedVersion:'v1',signedVersionId:1,outdatedSignature:false,expiredSignature:false},
   {id:2,versionId:2,name:'Safety policy',version:'v2',signed:false,signedAt:null,signedVersion:null,signedVersionId:null,outdatedSignature:false,expiredSignature:false},
  ],
 );
 expect(screen.getByRole('columnheader',{name:'Waiver Name'})).toBeTruthy();
 expect(screen.getByRole('columnheader',{name:'Signed Status'})).toBeTruthy();
 expect(screen.getByRole('columnheader',{name:'Date Signed'})).toBeTruthy();
 expect(screen.getByText('Shop waiver')).toBeTruthy();
 expect(screen.getByText('Safety policy')).toBeTruthy();
 expect(screen.getByText('signed')).toBeTruthy();
 expect(screen.getByText('not signed')).toBeTruthy();
 expect(document.querySelector('tbody tr:first-child td:last-child')?.textContent).not.toBe('');
 expect(screen.getByText('MM/DD/YYYY')).toBeTruthy();
 expect(screen.getByRole('button',{name:'View policy'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Review and agree'})).toBeTruthy();
});
test('member demo shows available equipment under upcoming',()=>{
 mount(
  {},
  {demoLogin:true,user:{role:'member',email:'demo.member@collaboratory.invalid'}},
  [],
  [
   {id:1,name:'Laser Engraver',status:'available',trainingRequired:true,certification:'Laser Engraver'},
   {id:2,name:'3D Printer',status:'available',trainingRequired:false,certification:null},
   {id:3,name:'Wood Lathe',status:'maintenance',trainingRequired:true,certification:'Wood Lathe'},
  ],
 );
 expect(screen.getByRole('heading',{name:'Schedule Training'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Available'}).getAttribute('aria-expanded')).toBe('false');
 expect(screen.getByRole('button',{name:'Upcoming'}).getAttribute('aria-expanded')).toBe('true');
 expect(screen.getByRole('button',{name:'Completed'}).getAttribute('aria-expanded')).toBe('false');
 expect(
  Array.from(document.querySelectorAll('.training-schedule .training-card h3')).map((heading)=>heading.textContent),
 ).toEqual(['Laser Engraver','3D Printer']);
 expect(screen.getAllByText('1 hour session')).toHaveLength(2);
 expect(screen.getAllByText('$20.00')).toHaveLength(2);
 expect(document.querySelectorAll('.training-card__duration svg')).toHaveLength(2);
 const filter = screen.getByRole('combobox', {name:'Filter training by status'});
 fireEvent.change(filter, {target:{value:'upcoming'}});
 expect(screen.getByRole('button',{name:'Upcoming'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Available'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Completed'})).toBeNull();
 fireEvent.change(filter, {target:{value:'completed'}});
 expect(screen.getByRole('button',{name:'Completed'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Upcoming'})).toBeNull();
});
test('heading styling is not applied to other accounts',()=>{
 mount({}, {demoLogin:true,user:{role:'admin',email:'demo.admin@collaboratory.invalid'}});
 expect(document.querySelector('.credentials-page--member-demo')).toBeNull();
});
