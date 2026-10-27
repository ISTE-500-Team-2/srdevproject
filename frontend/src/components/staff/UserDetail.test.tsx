// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {UserDetail} from './UserDetail';
const {api,reload,state}=vi.hoisted(()=>({api:vi.fn(),reload:vi.fn(),state:{data:null as any}}));
vi.mock('../../lib/api',()=>({api,ApiError:class extends Error{status=409;},errorMessage:(e:Error)=>e.message}));
vi.mock('../../lib/useApi',()=>({useApi:()=>({data:state.data,loading:false,error:'',reload})}));
vi.mock('../../context/AuthContext',()=>({useAuth:()=>({user:{id:12,roles:['admin']}})}));
vi.mock('./AccessReadiness',()=>({AccessReadiness:({userId,revision}:any)=><div data-testid="readiness">Readiness for {userId} revision {revision}</div>}));
vi.mock('./IssueAccess',()=>({IssueAccess:()=>null}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){state.data={user:{id:14,firstName:'Casey',lastName:'Demo',email:'casey@example.invalid',roles:['member'],status:'active',accessStatus:'active',revision:7},memberships:[],passes:[],payments:{items:[],nextOffset:null},audit:{items:[{id:'9',actorName:'System',entityId:9,entityType:'app_device_access_event',action:'app_device_access_event.insert',createdAt:'2026-10-27T16:18:49Z',allowed:false,accessReason:'ENTITLEMENT_REQUIRED',subjectName:'Casey Demo',resourceName:'3D Printer'}],nextOffset:null},checkIns:[]};render(<UserDetail id={14} plans={[]} timeZone="America/New_York" onChanged={reload}/>);}
test('labels account restriction separately and delegates eligibility to shared backend preview',()=>{mount();expect(screen.getByText('None')).toBeTruthy();expect(screen.getByTestId('readiness').textContent).toBe('Readiness for 14 revision 7');expect(screen.queryByText('Membership / day pass missing.')).toBeNull();});
test('facility save submits selected status with current revision and refreshes server state',async()=>{mount();api.mockResolvedValue({});const form=screen.getByRole('form',{name:'Facility access control'});fireEvent.change(within(form).getByRole('combobox'),{target:{value:'suspended'}});fireEvent.change(within(form).getByLabelText('Reason for change'),{target:{value:'Safety test'}});fireEvent.submit(form);await waitFor(()=>expect(api).toHaveBeenCalledWith('/admin/users/14/access',{method:'POST',body:{status:'suspended',revision:7,reason:'Safety test'}}));await waitFor(()=>expect(reload).toHaveBeenCalledTimes(2));});

test('a second status save uses the committed revision even before detail GET finishes',async()=>{
 mount();api.mockResolvedValueOnce({...state.data.user,status:'inactive',revision:8});
 let form=screen.getByRole('form',{name:'Account status control'});
 fireEvent.change(within(form).getByRole('combobox'),{target:{value:'inactive'}});
 fireEvent.change(within(form).getByLabelText('Reason for change'),{target:{value:'First change'}});fireEvent.submit(form);
 await waitFor(()=>expect(screen.getByTestId('readiness').textContent).toContain('revision 8'));
 api.mockResolvedValueOnce({...state.data.user,status:'active',revision:9});
 form=screen.getByRole('form',{name:'Account status control'});fireEvent.change(within(form).getByRole('combobox'),{target:{value:'active'}});
 fireEvent.change(within(form).getByLabelText('Reason for change'),{target:{value:'Second change'}});fireEvent.submit(form);
 await waitFor(()=>expect(api).toHaveBeenLastCalledWith('/admin/users/14/status',{method:'POST',body:{status:'active',revision:8,reason:'Second change'}}));
});
