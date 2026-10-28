// @vitest-environment jsdom
import {render,screen,fireEvent} from '@testing-library/react';
import {describe,it,expect} from 'vitest';
import {AuditList} from './Management';
describe('readable activity',()=>{
  it('shows the real denied outcome and hides database noise by default',()=>{
    const base={actorId:null,actorName:'System',subjectId:14,entityId:2,createdAt:'2026-10-27T16:07:56Z'};
    render(<AuditList items={[{...base,id:'1',entityType:'app_device_access_event',action:'app_device_access_event.insert',allowed:false,accessReason:'ACCOUNT_BLOCKED',subjectName:'Casey Demo',resourceName:'3D Printer'},{...base,id:'2',entityType:'user',action:'user.update'}]}/>);
    expect(screen.getByText('Card tap denied')).toBeTruthy();
    expect(screen.getByText('Casey Demo · 3D Printer')).toBeTruthy();
    expect(screen.queryByText('Account updated')).toBeNull();
    fireEvent.click(screen.getByLabelText('Show system details'));
    expect(screen.getByText('Account updated')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'nothing matches'}});
    expect(screen.getByText('No activity matches these filters.')).toBeTruthy();
  });
});
