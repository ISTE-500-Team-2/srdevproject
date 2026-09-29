// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {PassBilling} from './PassBilling';
const {api,reload,useApi}=vi.hoisted(()=>({api:vi.fn(),reload:vi.fn(),useApi:vi.fn()}));
vi.mock('../lib/api',()=>({api,errorMessage:(e:Error)=>e.message}));
vi.mock('../lib/useApi',()=>({useApi}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const offer={id:3,name:'Day pass',kind:'day_pass',price:'15.00',amountCents:1000,basis:'student',revision:2,pricingRevision:4};
test('day pass requires a date, displays eligible price, and sends only server-quoted pricing',async()=>{
 useApi.mockImplementation((path:string)=>({data:path.includes('offers')?[offer]:[],loading:false,error:'',reload}));render(<PassBilling/>);
 const button=screen.getByRole('button',{name:/Buy Day pass/}) as HTMLButtonElement;expect(button.disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Visit date'),{target:{value:'2030-01-10'}});expect(button.disabled).toBe(false);expect(button.textContent).toContain('10.00');
 api.mockRejectedValue(new Error('Refresh price'));fireEvent.click(button);
 expect((await screen.findByRole('status')).textContent).toContain('Refresh price');
 expect(api).toHaveBeenCalledWith('/me/billing/passes/checkout',{method:'POST',body:{planId:3,expectedRevision:2,pricingRevision:4,amountCents:1000,validDate:'2030-01-10'}});
 expect(screen.getByText(/3 days/)).toBeTruthy();
});
test('eligible free month is clearly non-recurring and never opens card checkout',async()=>{
 useApi.mockImplementation((path:string)=>({data:path.includes('offers')?[{...offer,kind:'membership',name:'Partner month',amountCents:0}]:[],loading:false,error:'',reload}));render(<PassBilling/>);
 api.mockResolvedValue({issued:true});fireEvent.click(screen.getByRole('button',{name:/free for one month, no automatic renewal/}));
 await screen.findByRole('status');expect(api).toHaveBeenCalledWith('/me/billing/free-membership',{method:'POST',body:{planId:3,expectedRevision:2,pricingRevision:4}});
});
