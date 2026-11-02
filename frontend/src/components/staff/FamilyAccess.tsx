import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { ActionForm, LoadState, ReasonField } from '../Management';
import { MemberSelect } from '../MemberSelect';
type Summary={isMinor:boolean;marker:string|null;sponsor:{id:number;name:string;revision:number}|null;visit:{id:number;buildingId:number}|null};
export function FamilyAccess({userId,disabled=false}:{userId:number;disabled?:boolean}) {
  const data=useApi<Summary>(`/admin/users/${userId}/supervision`,{refreshInterval:15000,retainOnReload:true});
  const [adult,setAdult]=useState('');
  const root=`/admin/users/${userId}/supervision`;
  return <section className="panel management-panel" aria-label="Visit and sponsoring adult">
    <h2>Visit &amp; supervision</h2><LoadState {...data}/>
    {data.data && <>
      <p>{data.data.isMinor ? <strong>Under 18</strong> : 'Adult account'} · {data.data.visit ? 'Checked in' : 'Checked out'}</p>
      {data.data.isMinor && <>
        <p>Sponsoring adult: <strong>{data.data.sponsor?.name ?? 'Not linked'}</strong></p>
        <p>The adult checks in with the minor and stays in the building. Checking out the adult also checks out their minors and blocks further equipment access.</p>
        <details><summary>Link sponsoring adult</summary>
          <ActionForm title="Sponsoring adult" submitLabel="Save sponsoring adult" disabled={disabled || !!data.data.visit}
            onSubmit={async form=>{await api(root,{method:'POST',body:{adultId:Number(adult),revision:data.data?.sponsor?.revision ?? 0,consent:form.get('consent')==='on',reason:form.get('reason')}});setAdult('');data.reload();}}>
            <MemberSelect label="Adult account" name="adultId" value={adult} onChange={setAdult}/>
            <label><input type="checkbox" name="consent" required/> I verified the adult agrees to sponsor this minor.</label>
            <ReasonField/>
          </ActionForm>
          {data.data.visit && <p>Check out the minor before changing their sponsoring adult.</p>}
        </details>
      </>}
      <ActionForm key={data.data.visit?.id ?? "new-visit"} disabled={disabled} title={data.data.visit ? 'End facility visit' : 'Start facility visit'} submitLabel={data.data.visit ? 'Check out' : 'Check in with staff'}
        onSubmit={async form=>{await api(`${root}/${data.data?.visit?'check-out':'check-in'}`,{method:'POST',body:{reason:form.get('reason')}});data.reload();}}>
        <p>{data.data.visit ? 'Ending an adult’s visit also ends visits for every minor they are supervising.' : 'Confirm this visitor is physically present. Each person needs their own valid pass/membership and current signed policies.'}</p>
        <ReasonField/>
      </ActionForm>
    </>}
  </section>;
}
