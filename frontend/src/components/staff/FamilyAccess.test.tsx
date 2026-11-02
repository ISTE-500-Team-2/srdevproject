// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {FamilyAccess} from './FamilyAccess';
const {api,reload,state}=vi.hoisted(()=>({api:vi.fn(),reload:vi.fn(),state:{data:{isMinor:true,marker:'Under 18',sponsor:{id:5,name:'Adult Sponsor',revision:3},visit:null as {id:number;buildingId:number}|null}}}));
vi.mock('../../lib/api',()=>({api,errorMessage:(e:Error)=>e.message}));
vi.mock('../../lib/useApi',()=>({useApi:()=>({data:state.data,loading:false,error:'',reload})}));
vi.mock('../MemberSelect',()=>({MemberSelect:({onChange}:any)=><button type="button" onClick={()=>onChange('8')}>Pick adult</button>}));
afterEach(()=>{cleanup();vi.clearAllMocks();state.data.visit=null;});
test('staff sees permanent minor marker, linked sponsor, and explicit consent requirement',async()=>{
 api.mockResolvedValue({});render(<FamilyAccess userId={42}/>);
 expect(screen.getByText('Under 18')).toBeTruthy();expect(screen.getByText('Adult Sponsor')).toBeTruthy();
 fireEvent.click(screen.getByText('Link sponsoring adult'));fireEvent.click(screen.getByText('Pick adult'));
 expect((screen.getByRole('checkbox') as HTMLInputElement).required).toBe(true);
 fireEvent.click(screen.getByRole('checkbox'));
 const forms=screen.getAllByLabelText('Reason for change');fireEvent.change(forms[0],{target:{value:'Identity and adult agreement verified'}});
 fireEvent.submit(screen.getByRole('form',{name:'Sponsoring adult'}));
 await waitFor(()=>expect(api).toHaveBeenCalledWith('/admin/users/42/supervision',{method:'POST',body:{adultId:8,revision:3,consent:true,reason:'Identity and adult agreement verified'}}));
});
test('an active visit disables sponsor reassignment and offers checkout with cascade explanation',()=>{
 state.data.visit={id:1,buildingId:1};render(<FamilyAccess userId={42}/>);
 fireEvent.click(screen.getByText('Link sponsoring adult'));
 const save=screen.getByRole('button',{name:'Save sponsoring adult'});expect((save.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
 expect(screen.getByRole('button',{name:'Check out'})).toBeTruthy();expect(screen.getByText(/Ending an adult’s visit also ends visits/)).toBeTruthy();
});

test('protected staff targets disable both sponsor and visit mutations',()=>{
 render(<FamilyAccess userId={42} disabled/>);fireEvent.click(screen.getByText('Link sponsoring adult'));
 for(const name of ['Save sponsoring adult','Check in with staff'])
  expect((screen.getByRole('button',{name}).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
 fireEvent.submit(screen.getByRole('form',{name:'Start facility visit'}));expect(api).not.toHaveBeenCalled();
});
