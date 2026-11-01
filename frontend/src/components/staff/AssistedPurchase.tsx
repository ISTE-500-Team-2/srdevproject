import { useState, type ComponentProps } from 'react';
import { api, ApiError } from '../../lib/api';
import { cents, zonedDay } from '../../lib/display';
import type { Offer } from '../../lib/billingContracts';
import { useApi } from '../../lib/useApi';
import { ActionForm, Field, LoadState } from '../Management';
import { IssueAccess } from './IssueAccess';

export function AssistedPurchase(props: ComponentProps<typeof IssueAccess>) {
  const [method, setMethod] = useState(props.renewal ? 'external' : 'stripe');
  const [date, setDate] = useState(zonedDay(props.timeZone));
  const [planId, setPlanId] = useState('');
  const purchase = useApi<{ enabled: boolean; offers: Offer[] }>(
    method === 'stripe' ? `/admin/users/${props.id}/purchase?date=${encodeURIComponent(date)}` : null,
  );
  const offer = purchase.data?.offers?.find(item => item.id === Number(planId));
  return <div className="assisted-purchase">
    <h2>Purchase membership or day pass</h2>
    <p>Help this member complete a purchase. Card payments open secure Stripe checkout.</p>
    <Field label="How will the member pay?" name="purchaseMethod">
      <select value={method} onChange={event => setMethod(event.target.value)}>
        <option value="stripe">Pay by card with Stripe</option>
        <option value="external">Payment already collected or approved waiver</option>
      </select>
    </Field>
    {method === 'external' ? <IssueAccess {...props} /> : <>
      <LoadState {...purchase} />
      {purchase.data?.enabled === false ? <p className="form-notice">Card checkout is not configured in this environment. You can record a payment already collected outside this app or an approved waiver.</p> : null}
      <ActionForm title="Card purchase" submitLabel={offer?.amountCents === 0 ? 'Issue approved free access' : 'Continue to Stripe'}
        disabled={props.disabled || purchase.loading}
        submitDisabled={!offer || (offer.amountCents > 0 && !purchase.data?.enabled)}
        onSubmit={async form => {
          if (!offer || purchase.loading) throw new ApiError(409, 'PRICE_CHANGED', 'Review the current price before continuing.');
          const result = await api<{ checkoutUrl?: string; issued?: boolean }>(`/admin/users/${props.id}/purchase`, {
            method: 'POST', body: { planId: offer.id, expectedRevision: offer.revision, pricingRevision: offer.pricingRevision,
              amountCents: offer.amountCents, validDate: offer.kind === 'day_pass' ? date : undefined,
              autoRenewConsent: form.get('autoRenewConsent') === 'on', freeMembership: offer.kind === 'membership' && offer.amountCents === 0 },
          });
          if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
          if (!result.issued) throw new Error('Checkout did not complete. Refresh and review the member’s records.');
          props.onSaved();
        }}>
        <Field label="Plan to purchase" name="planId">
          <select value={planId} onChange={event => setPlanId(event.target.value)} required>
            <option value="">Choose a plan</option>
            {(purchase.data?.offers ?? []).map(item => <option key={item.id} value={item.id}>{item.name} · {cents(item.amountCents)}{item.kind === 'membership' ? ' / month' : ''}</option>)}
          </select>
        </Field>
        {offer?.kind === 'day_pass' ? <Field label={`Pass valid date (${props.timeZone})`} name="validDate">
          <input type="date" required min={zonedDay(props.timeZone)} value={date} onChange={event => setDate(event.target.value)} />
        </Field> : null}
        {offer?.kind === 'membership' && offer.amountCents > 0 ? <>
          <p>This membership starts after payment and renews monthly at {cents(offer.amountCents)}. Future rates depend on the member’s eligibility.</p>
          <label><input type="checkbox" name="autoRenewConsent" required /> The member has agreed to monthly automatic renewal.</label>
        </> : null}
        <p>Access is issued only after Stripe confirms payment, or after approved free access is verified. Cancelling checkout does not issue access.</p>
        {purchase.data?.enabled ? <p className="activity-byline">Stripe is currently in test mode. Use a test card; no real payment is collected.</p> : null}
      </ActionForm>
    </>}
  </div>;
}
