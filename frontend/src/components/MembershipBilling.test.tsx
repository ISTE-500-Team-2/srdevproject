// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MembershipBilling} from './MembershipBilling';
const {api,reload,useApi}=vi.hoisted(()=>({api:vi.fn(),reload:vi.fn(),useApi:vi.fn()}));
vi.mock('../lib/api',()=>({api,errorMessage:(e:Error)=>e.message}));
vi.mock('../lib/useApi',()=>({useApi}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const plan={id:1,name:'Monthly',kind:'membership' as const,price:'50.00',months:1,benefits:'Test',active:true,revision:2};
function mount(enabled=true,records:any[]=[]) {useApi.mockReturnValue({data:{enabled,records},loading:false,error:'',reload});render(<MembershipBilling plans={[plan]}/>);}
test('billing cannot be started without explicit consent; provider errors remain visible',async()=>{
 mount();const button=screen.getByRole('button',{name:/Continue with Monthly/}) as HTMLButtonElement;
 expect(button.disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));expect(button.disabled).toBe(false);
 api.mockRejectedValue(new Error('Price changed; refresh first.'));fireEvent.click(button);
 expect((await screen.findByRole('status')).textContent).toContain('Price changed');
 expect(api).toHaveBeenCalledWith('/me/billing/checkout',{method:'POST',body:{planId:1,expectedRevision:2,autoRenewConsent:true}});
});
test('missing configuration does not present a working checkout',()=>{mount(false);expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.getByText(/Online membership checkout is not configured/)).toBeTruthy();});
test('stop renewal uses owned record and does not promise refund or access revocation',async()=>{
 mount(true,[{id:'billing-fixture',plan,status:'active',amountCents:5000,cancelAtPeriodEnd:false,currentPeriodEnd:'2030-02-01T00:00:00Z'}]);
 api.mockResolvedValue({});fireEvent.click(screen.getByRole('button',{name:'Stop automatic renewal'}));
 await waitFor(()=>expect(reload).toHaveBeenCalledOnce());
 expect(screen.getByRole('status').textContent).toContain('already-paid membership period is unchanged');
});
