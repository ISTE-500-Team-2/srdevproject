import {useApi} from '../lib/useApi';
import {api} from '../lib/api';
import {ActionForm,ReasonField,LoadState,dollars} from './Management';
interface Invoice {id:string;userId:number;planName:string;amountCents:number;periodStart:string;periodEnd:string;refundStatus:string|null}
export function BillingRefunds() {
 const invoices=useApi<Invoice[]>('/billing-management/invoices');
 return <section className="panel management-panel"><h3>Stripe test membership payments</h3>
  <p>Refunds here return the full invoice payment to its original card in Stripe test mode. They do not stop future renewal or change access; manage those separately.</p>
  <LoadState {...invoices}/>{invoices.data?.length===0&&<p>No Stripe membership payments recorded.</p>}
  {invoices.data?.map(i=><article className="management-record" key={i.id}>
   <h4>{i.planName} — member #{i.userId}</h4><p>{dollars((i.amountCents/100).toFixed(2))} · {i.id} · Refund: {i.refundStatus??'Not requested'}</p>
   {i.refundStatus!=='succeeded'&&<ActionForm title={`Refund ${i.id}`} submitLabel="Refund full payment to original card (test)" onSubmit={async f=>{
    await api(`/billing-management/invoices/${encodeURIComponent(i.id)}/refund`,{method:'POST',body:{reason:f.get('reason')}});invoices.reload();
   }}><ReasonField/></ActionForm>}
  </article>)}
 </section>;
}
