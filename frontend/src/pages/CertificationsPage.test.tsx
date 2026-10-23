// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CertificationsPage } from './CertificationsPage';
const { api, reload, state } = vi.hoisted(() => ({ api:vi.fn(),reload:vi.fn(),state: { waivers: [] as any[] } }));
vi.mock('../lib/api',()=>({api,errorMessage:(error:Error)=>error.message}));
vi.mock('../lib/useApi', () => ({ useApi: (path:string) => ({data:path === '/me/waivers' ? state.waivers : [],loading:false,error:null,reload}) }));
vi.mock('../context/AuthContext',()=>({useAuth:()=>({user:{roles:['member']}})}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(overrides:object) {
 state.waivers=[{id:2,versionId:2,name:'Shop policy',version:'v2',signed:false,signedVersion:'v2',signedVersionId:2,outdatedSignature:false,expiredSignature:true,...overrides}];
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
test('terms require acceptance before submission and record the completed agreement',async()=>{
 mount({name:'Terms of Service',version:'2026-09-28',description:'Terms text',expiredSignature:false});
 fireEvent.click(screen.getByRole('button',{name:'Review and agree'}));
 const submit=screen.getByRole('button',{name:'Submit acceptance'}) as HTMLButtonElement;
 expect(submit.disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox',{name:'I have read and accept the Terms of Service.'}));
 expect(submit.disabled).toBe(false);
 api.mockResolvedValue({});
 fireEvent.click(submit);
 await waitFor(()=>expect(api).toHaveBeenCalledWith('/me/waivers/2/sign',{method:'POST',body:{accepted:true}}));
 expect(reload).toHaveBeenCalled();
 expect(screen.getByText('Terms of Service completed.')).toBeTruthy();
});
test('accepted terms are marked completed',()=>{
 mount({name:'Terms of Service',signed:true,signedAt:'2026-10-22T12:00:00Z',expiredSignature:false});
 expect(screen.getByText(/Completed/)).toBeTruthy();
});
