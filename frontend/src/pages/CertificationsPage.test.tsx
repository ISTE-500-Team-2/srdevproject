// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CertificationsPage } from './CertificationsPage';
const { state } = vi.hoisted(() => ({ state: { waivers: [] as any[] } }));
vi.mock('../lib/useApi', () => ({ useApi: (path:string) => ({data:path === '/me/waivers' ? state.waivers : [],loading:false,error:null,reload:vi.fn()}) }));
vi.mock('../context/AuthContext',()=>({useAuth:()=>({user:{roles:['member']}})}));
afterEach(cleanup);
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
