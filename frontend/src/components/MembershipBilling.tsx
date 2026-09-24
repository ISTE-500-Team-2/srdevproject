import {useState} from 'react';
import {useApi} from '../lib/useApi';
import {api,errorMessage} from '../lib/api';
import type {Plan} from '../lib/staffContracts';
import {LoadState,dollars} from './Management';
interface Billing {id:string;status:string;plan:Plan;amountCents:number;cancelAtPeriodEnd:boolean;currentPeriodEnd:string|null}
export function MembershipBilling({plans}:{plans:Plan[]}) {
 const eligiblePlans=plans.filter(p=>p.kind==='membership'&&p.months===1&&p.active&&Number(p.price)>=0.50&&Number(p.price)<=100000);
 const state=useApi<{enabled:boolean;records:Billing[]}>('/me/billing');
 const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function act(path:string,body:unknown={}) {
  setBusy(true);setMessage('');
  try {
   const result=await api<{checkoutUrl?:string;url?:string}>(path,{method:'POST',body});
   const url=result.checkoutUrl??result.url;
   if(url) {window.location.assign(url);return;}
   state.reload();setMessage('Automatic renewal stopped. Your already-paid membership period is unchanged.');
  }catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}
 }
 return <section className="panel management-panel">
  <h2>Monthly card membership</h2><LoadState {...state}/>
  {state.data?.enabled ? <>
   <p>Test payments only. No real money is charged. Membership starts only after payment is verified.</p>
   {state.data.records.filter(r=>!['canceled','expired','incomplete_expired'].includes(r.status)).map(r=><article className="management-record" key={r.id}>
    <h3>{r.plan.name}</h3><p>{dollars((r.amountCents/100).toFixed(2))} per month · {r.status}</p>
    <p>Auto-renew: {r.cancelAtPeriodEnd?'Off':'On'}. {r.currentPeriodEnd&&`Current billing period ends ${new Date(r.currentPeriodEnd).toLocaleDateString()}.`}</p>
    <button className="button button--quiet" disabled={busy||r.cancelAtPeriodEnd} onClick={()=>act(`/me/billing/${r.id}/cancel`)}>{r.status==='pending'?'Cancel checkout':'Stop automatic renewal'}</button>
    {r.status!=='pending'&&<button className="button button--quiet" disabled={busy} onClick={()=>act(`/me/billing/${r.id}/portal`)}>Manage payment method</button>}
   </article>)}
   <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I agree to the displayed monthly amount being charged automatically each month until I stop renewal.</label>
   {eligiblePlans.length===0&&<p>No monthly card rate is available. Contact staff.</p>}
   {eligiblePlans.map(p=><p key={p.id}><button className="button button--quiet" disabled={busy||!consent} onClick={()=>act('/me/billing/checkout',{planId:p.id,expectedRevision:p.revision,autoRenewConsent:true})}>Continue with {p.name} — {dollars(p.price)}/month</button></p>)}
   <button className="button button--quiet" disabled={busy} onClick={()=>state.reload()}>Refresh payment status</button>
  </>:state.data&&<p>Online membership checkout is not configured. Contact staff for membership or cash/card payment recording.</p>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
