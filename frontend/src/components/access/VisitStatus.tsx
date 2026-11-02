import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useApi } from '../../lib/useApi';
export function VisitStatus() {
  const state=useApi<{isMinor:boolean;sponsor:{name:string}|null;visit:{id:number}|null}>('/me/supervision',{refreshInterval:15000,retainOnReload:true});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!state.data)return state.error?<p className="form-error" role="alert">{state.error}</p>:null;
  if(!state.data.isMinor && !state.data.visit)return null;
  return <section className="panel management-panel" aria-label="Your facility visit">
    {state.data.isMinor && <p><strong>Under 18</strong> · Sponsoring adult: {state.data.sponsor?.name ?? 'Ask staff to link your adult'}</p>}
    {state.data.visit && <><p>You are checked in. When you leave, check out here or ask staff. If you supervise minors, checking out also ends their visits.</p>
      <button type="button" className="button button--quiet" disabled={busy} onClick={async()=>{
        setBusy(true);setError('');try{await api('/me/visit/check-out',{method:'POST',body:{}});state.reload();}
        catch(e){setError(errorMessage(e));}finally{setBusy(false);}
      }}>{busy?'Checking out…':'Check out of the building'}</button></>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
