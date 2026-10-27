// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {UserDetail} from './UserDetail';
const {api,reload,state}=vi.hoisted(()=>({api:vi.fn(),reload:vi.fn(),state:{data:null as any}}));
vi.mock('../../lib/api',()=>({api,ApiError:class extends Error{status=409;},errorMessage:(e:Error)=>e.message}));
vi.mock('../../lib/useApi',()=>({useApi:()=>({data:state.data,loading:false,error:'',reload})}));
vi.mock('../../context/AuthContext',()=>({useAuth:()=>({user:{id:12,roles:['admin']}})}));
vi.mock('../SignedWaiverRecords',()=>({SignedWaiverRecords:()=>null}));
vi.mock('./IssueAccess',()=>({IssueAccess:()=>null}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){state.data={user:{id:14,firstName:'Casey',lastName:'Demo',email:'casey@example.invalid',roles:['member'],status:'active',accessStatus:'active',revision:7},memberships:[],passes:[],payments:{items:[],nextOffset:null},audit:{items:[{id:'9',actorName:'System',entityId:9,entityType:'app_device_access_event',action:'app_device_access_event.insert',createdAt:'2026-10-27T16:18:49Z',allowed:false,accessReason:'ENTITLEMENT_REQUIRED',subjectName:'Casey Demo',resourceName:'3D Printer'}],nextOffset:null},checkIns:[]};render(<UserDetail id={14} plans={[]} timeZone="America/New_York" onChanged={reload}/>);}
test('active restriction does not claim eligibility and surfaces the actual missing pass and latest denial',()=>{mount();expect(screen.getByText('Membership / day pass missing.')).toBeTruthy();expect(screen.getByText('No staff access restriction')).toBeTruthy();expect(within(screen.getByLabelText('Live access status')).getByText('An active membership or day pass is required.')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Refresh now'}));expect(reload).toHaveBeenCalledTimes(2);});
test('facility save submits selected status with current revision and refreshes server state',async()=>{mount();api.mockResolvedValue({});const form=screen.getByRole('form',{name:'Facility access control'});fireEvent.change(within(form).getByRole('combobox'),{target:{value:'suspended'}});fireEvent.change(within(form).getByLabelText('Reason for change'),{target:{value:'Safety test'}});fireEvent.submit(form);await waitFor(()=>expect(api).toHaveBeenCalledWith('/admin/users/14/access',{method:'POST',body:{status:'suspended',revision:7,reason:'Safety test'}}));await waitFor(()=>expect(reload).toHaveBeenCalledTimes(2));});
