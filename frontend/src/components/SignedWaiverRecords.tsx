import {useState} from 'react';
import {api,errorMessage} from '../lib/api';
import {useApi} from '../lib/useApi';
import {ActionForm,Field,LoadState,ReasonField,localInput,dateTime} from './Management';
interface SignedWaiver {id:number;waiverId:number;name:string;version:string;signedAt:string;expiresAt:string|null;approved:boolean;copyAvailable:boolean}
export function SignedWaiverRecords({userId,onChanged}:{userId?:number;onChanged?:()=>void}) {
  const path=userId?`/admin/users/${userId}/signed-waivers`:'/me/signed-waivers';
  const records=useApi<SignedWaiver[]>(path);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState<number|null>(null);
  const download=async(id:number)=>{
    setError('');setBusy(id);
    try {
      const copy=await api<{fileName:string;content:string;contentType:string}>(`${path}/${id}/copy`);
      const url=URL.createObjectURL(new Blob([copy.content],{type:'text/plain;charset=utf-8'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download=copy.fileName;
      document.body.appendChild(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(err){setError(errorMessage(err));}finally{setBusy(null);}
  };
  return <section className="panel management-panel">
    <h2>Signed waiver copies</h2>
    <p>Download the wording and electronic agreement recorded when signed. Copies remain available when notification emails are disabled.</p>
    <LoadState {...records}/>
    {error?<p role="alert">{error}</p>:null}
    {records.data?.length===0?<p>No signed waivers have been recorded.</p>:null}
    <div className="management-records">{records.data?.map(record=><article className="management-record" key={record.id}>
      <h3>{record.name} · {record.version}</h3>
      <p>Signed {dateTime(record.signedAt)}{!record.approved?' · Historical agreement':''}</p>
      <p>{record.expiresAt?`Expiration: ${dateTime(record.expiresAt)}`:'No expiration date has been recorded.'}</p>
      {record.copyAvailable?<button type="button" className="button button--quiet" disabled={busy!==null} onClick={()=>void download(record.id)}>{busy===record.id?'Preparing…':'Download signed copy'}</button>
        :<p>This older signature has no preserved signed-text copy. Ask staff for its original record.</p>}
      {userId?<details><summary>Set or clear expiration</summary>
        <ActionForm key={`${record.id}-${record.expiresAt}`} title="Waiver expiration" submitLabel="Save expiration" onSubmit={async form=>{
          const date=String(form.get('expiresAt')??'');
          await api(`${path}/${record.id}/expiry`,{method:'PATCH',body:{expiresAt:date?new Date(date).toISOString():null,expectedExpiry:record.expiresAt,reason:form.get('reason')}});
          records.reload();onChanged?.();
        }}>
          <p>Enter only the approved expiration for this signed agreement. Leave blank to clear it; no default validity period is assumed.</p>
          <Field name="expiresAt" label="Expiration (your local time)" type="datetime-local" required={false} defaultValue={record.expiresAt?localInput(new Date(record.expiresAt)):''}/>
          <ReasonField/>
        </ActionForm></details>:null}
    </article>)}</div>
  </section>;
}
