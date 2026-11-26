// Links a reservation's pending payment to Stripe checkout; provider reconciliation decides
// when the booking becomes paid.

import type { Pool } from 'pg';
import Stripe from 'stripe';
import { transaction } from '../db.js';
import { AppError, textField } from '../domain.js';
import { requireActor } from '../accountPolicy.js';
import { assertManageable } from '../services/StaffService.js';
import { ReservationModel } from '../models/ReservationModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { enqueueNotification } from '../notifications/store.js';
import { noticeCertificationRefusal } from '../notifications/certificationNotices.js';
import { StudioStripe } from '../studios/stripe.js';
import { assertStripeMode, inStripeMode, modeOf, paymentLabels } from '../stripeMode.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { AccessService } from '../services/AccessService.js';
import type { Database } from '../db.js';
import { errorIdentifier } from '../logSafety.js';
import { failedRefund, liveRefund, refundAttempt, refundTransition, replacedAttemptFailed } from './refundTransition.js';
import { isRefundEvent, type RefundEvent } from './stripeEvents.js';
import { providerTransaction } from './providerGate.js';

/** A paid booking's checkout with its booked member, as a refund reads it. */
interface RefundableCheckout {
  reservation_id: number;
  userid: number;
  /** Whose card paid, and so gets the money back: the booked member, or whoever booked for them. */
  payer_id: number;
  status: string;
  amount_cents: number;
  payment_id: number | null;
  payment_intent: string | null;
  refund_id: string | null;
  refund_status: string | null;
}
const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;

/** Server-priced equipment holds. Only canonical paid Stripe state confirms a booking. */
export class EquipmentBilling {
  constructor(readonly pool: Pool, readonly stripe?: StudioStripe, readonly zone = 'America/New_York') {}

  private async requirements(db: Database, reservation: {userid: number; equipmentid: number; endsAt: Date}) {
    const equipment = await new EquipmentModel(db).findForUpdate(reservation.equipmentid);
    if (!equipment) throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
    await new AccessService(db, this.zone).assertEquipmentRequirements(reservation.userid, equipment, reservation.endsAt);
  }

  provider() {
    if (!this.stripe) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Card payments are not configured. Please contact staff.');
    return this.stripe;
  }

  /**
   * Release a hold whose checkout session was never stored. Nobody got a payment link for it, and
   * any session the failed call did create expires at hold_until, so once the hold has passed
   * (`afterHold`), or Stripe definitely rejected the call, no payment can arrive for it.
   */
  private async expireUnopened(id: number, reason: string, afterHold: boolean) {
    return transaction(this.pool, async db => {
      await db.query('SELECT reservationid FROM reservation WHERE reservationid=$1 FOR UPDATE', [id]);
      const expired = await db.query(`UPDATE app_equipment_checkout SET status='expired' WHERE reservation_id=$1 AND status='pending'
        AND checkout_id IS NULL AND (NOT $2::boolean OR hold_until<=now()) RETURNING reservation_id`, [id, afterHold]);
      if (!expired.rowCount) return false;
      await db.query("UPDATE reservation SET status='cancelled',statusdesc=$2 WHERE reservationid=$1 AND status='pending'", [id, reason]);
      await db.query("UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now() WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1) AND paymentstatus='pending'", [id]);
      return true;
    });
  }

  /**
   * Create or reuse the provider checkout with a stable idempotency key; recheck the booked
   * member's requirements before returning a link.
   */
  async checkout(payerId: number, id: number) {
    const row = (await this.pool.query(`SELECT c.*,r.userid,r.equipmentid,r.endtime AT TIME ZONE 'UTC' AS "endsAt" FROM app_equipment_checkout c
      JOIN reservation r ON r.reservationid=c.reservation_id
      WHERE c.reservation_id=$1 AND c.payer_id=$2`, [id, payerId])).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Checkout not found.');
    if (row.status === 'expired') throw new AppError(409, 'CHECKOUT_EXPIRED', 'Payment time expired. Choose your time again.');
    if (row.status !== 'pending') return { ...await new ReservationModel(this.pool).find(id), amountCents: row.amount_cents };
    if (!row.checkout_id && new Date(row.hold_until).getTime() <= Date.now() && await this.expireUnopened(id, 'Unpaid checkout expired', true))
      throw new AppError(409, 'CHECKOUT_EXPIRED', 'Payment time expired. Choose your time again.');
    // Recheck the booked member, including staff-assisted and idempotent retries.
    // A checkout link must never bypass a waiver revoked after the initial hold.
    // A member resuming their own payment after their training lapsed is told how to renew it.
    await noticeCertificationRefusal(this.pool, this.zone, { memberId: row.userid, equipmentId: payerId === row.userid ? row.equipmentid : null },
      () => transaction(this.pool, db => this.requirements(db, row)));
    const provider = this.provider();
    // An ambiguous create response must reuse the original key, never charge again.
    if (!row.checkout_id && Date.now() - new Date(row.created_at).getTime() > 23 * 3600000)
      throw new AppError(409, 'RECONCILE_REQUIRED', 'Staff must reconcile this checkout before another payment.');
    const create = (holdUntil: Date) => provider.sdk.checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'],
        integration_identifier: 'arbor-equipment-checkout',
        client_reference_id: String(id), metadata: { equipmentReservationId: String(id) },
        payment_intent_data: { metadata: { equipmentReservationId: String(id) } },
        expires_at: Math.floor(new Date(holdUntil).getTime() / 1000),
        success_url: provider.config.origin + `/equipment?payment=returned&reservation=${id}`,
        cancel_url: provider.config.origin + `/equipment?payment=cancelled&reservation=${id}`,
        line_items: [{ quantity: row.hours, price_data: { currency: 'usd', unit_amount: row.hourly_cents,
          product_data: { name: `${row.equipment_name} — hourly reservation` } } }],
      }, { idempotencyKey: `equipment-checkout:${id}` });
    let session: Stripe.Checkout.Session;
    try {
      if (row.checkout_id) session = await provider.sdk.checkout.sessions.retrieve(row.checkout_id);
      else try {
        session = await create(row.hold_until);
      } catch (error) {
        // Stripe needs at least 30 minutes to pay, so resuming after a first create that never
        // reached Stripe finds the original hold too short. The rejection proves no session exists
        // under this key and saves no result for it, so renew a hold still running and try once more.
        const renewed = error instanceof Stripe.errors.StripeInvalidRequestError &&
          new Date(row.hold_until).getTime() - Date.now() < 30 * 60_000 ? await this.renewHold(id) : null;
        if (!renewed) throw error;
        session = await create(renewed);
      }
    } catch (error) {
      // A definite validation rejection created no checkout. Ambiguous network errors
      // keep the hold and its idempotency key so a retry cannot charge twice.
      if (!row.checkout_id && error instanceof Stripe.errors.StripeInvalidRequestError)
        await this.expireUnopened(id, 'Checkout creation rejected', false);
      throw new AppError(503, 'CHECKOUT_UNAVAILABLE', 'Stripe checkout could not be opened. Refresh your reservations and resume payment to try again.', undefined, { cause: error });
    }
    if (session.metadata?.equipmentReservationId !== String(id))
      throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment checkout identity mismatch.');
    await this.pool.query('UPDATE app_equipment_checkout SET checkout_id=$2 WHERE reservation_id=$1 AND checkout_id IS NULL', [id, session.id]);
    await this.apply(session);
    const reservation = await new ReservationModel(this.pool).find(id);
    if (!reservation) throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
    if (session.status === 'expired') throw new AppError(409, 'CHECKOUT_EXPIRED', 'Payment time expired. Choose your time again.');
    if (reservation.status === 'confirmed') return { ...reservation, amountCents: row.amount_cents };
    if (session.status !== 'open' || !session.url) throw new AppError(409, 'PAYMENT_PROCESSING', 'Your payment is being verified. Refresh your reservations shortly.');
    return { ...reservation, checkoutUrl: session.url, amountCents: row.amount_cents };
  }

  /**
   * Give a still-running hold that has no checkout yet a fresh 31 minutes. A concurrent resume
   * that already renewed it keeps that time, so both send Stripe the same request.
   */
  private async renewHold(id: number): Promise<Date | null> {
    return (await this.pool.query(`UPDATE app_equipment_checkout SET hold_until=CASE
      WHEN hold_until<clock_timestamp()+interval '30 minutes' THEN clock_timestamp()+interval '31 minutes' ELSE hold_until END
      WHERE reservation_id=$1 AND status='pending' AND checkout_id IS NULL AND hold_until>clock_timestamp()
      RETURNING hold_until`, [id])).rows[0]?.hold_until ?? null;
  }

  /**
   * Validate provider identity, amount and currency under a booking lock before changing
   * reservation/payment state.
   */
  async apply(session: Stripe.Checkout.Session) {
    const id = session.metadata?.equipmentReservationId;
    if (!id) return;
    const refundLookup = await transaction(this.pool, async db => {
      // Reservation first: use the same lock order as staff edits/cancellations.
      const reservation = (await db.query(`SELECT *,endtime AT TIME ZONE 'UTC' AS "endsAt" FROM reservation WHERE reservationid::text=$1 FOR UPDATE`, [id])).rows[0];
      const row = (await db.query('SELECT * FROM app_equipment_checkout WHERE reservation_id::text=$1 FOR UPDATE', [id])).rows[0];
      if (!row || !reservation) return;
      if (!inStripeMode(modeOf(this.stripe), session.livemode) || session.mode !== 'payment' || session.client_reference_id !== id ||
        row.checkout_id && session.id !== row.checkout_id || session.amount_total !== row.amount_cents || session.currency !== 'usd')
        throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment payment does not match this reservation.');
      if (row.status === 'pending' && session.status === 'expired' && session.payment_status === 'unpaid') {
        await db.query("UPDATE app_equipment_checkout SET status='expired',checkout_id=$2 WHERE reservation_id=$1", [id, session.id]);
        await db.query("UPDATE reservation SET status='cancelled',statusdesc='Unpaid checkout expired' WHERE reservationid=$1 AND status='pending'", [id]);
        await db.query("UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now() WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1) AND paymentstatus='pending'", [id]);
        return;
      }
      if (session.status !== 'complete' || session.payment_status !== 'paid') return;
      const intent = objectId(session.payment_intent);
      // A repeated checkout delivery can reconcile a refund lookup that failed after payment committed.
      if (row.status === 'paid') return row.payment_intent === intent && !!row.refund_reconcile_after;
      if (row.status !== 'pending') return;
      if (!intent || reservation.status !== 'pending') throw new AppError(409, 'RECONCILE_REQUIRED', 'Payment requires staff reconciliation.');
      // Payment alone cannot confirm a booking whose current waivers/training
      // are invalid. The same paid session can reconcile after eligibility is restored.
      await this.requirements(db, reservation);
      const model = new StaffModel(db), labels = paymentLabels(modeOf(this.stripe));
      const existingPayment = (await db.query(`UPDATE payment SET paymentstatus='paid',method='card',reference=$2,
        note=$4,revision=revision+1,updated_at=now()
        WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1)
          AND userid=$3 AND paymentstatus='pending' RETURNING paymentid AS id`, [id, session.id, reservation.userid, labels.equipmentNote])).rows[0];
      const payment = existingPayment?.id ?? await model.createPayment(reservation.userid, null, (row.amount_cents / 100).toFixed(2),
        'paid', 'card', session.id, labels.equipmentNote, row.payer_id);
      await db.query("UPDATE app_equipment_checkout SET status='paid',checkout_id=$2,payment_intent=$3,payment_id=$4,refund_reconcile_after=now() WHERE reservation_id=$1", [id, session.id, intent, payment]);
      await db.query("UPDATE reservation SET status='confirmed',statusdesc='Stripe payment verified',payment_id=$2,revision=revision+1 WHERE reservationid=$1", [id, payment]);
      const confirmed = await new ReservationModel(db).find(Number(id));
      if (!confirmed) throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
      await model.audit(row.payer_id, reservation.userid, 'reservation.payment_confirmed', 'reservation', Number(id),
        'Stripe equipment payment verified', null, { paymentId: payment, amountCents: row.amount_cents });
      await enqueueNotification(db, { userId: reservation.userid, kind: 'reservation_confirmed',
        dedupeKey: `equipment-confirmed:${id}`, payload: { reservationId: Number(id), resourceName: confirmed.equipmentName,
          startsAt: new Date(confirmed.startTime).toISOString(), endsAt: new Date(confirmed.endTime).toISOString() } });
      await enqueueNotification(db, { userId: row.payer_id, kind: 'payment_receipt', dedupeKey: `equipment-receipt:${id}`,
        payload: { paymentId: payment, reservationId: Number(id), amount: (row.amount_cents / 100).toFixed(2),
          currency: 'USD', method: labels.card, reference: session.id } });
      return true;
    });
    if (refundLookup) await this.reconcileRefund(Number(id));
  }

  private async reconcileRefund(id: number) {
    // A refund delivered before the payment was recorded had no booking to match. Look it up
    // after committing the charge so a partial refund or a Stripe outage can't undo confirmation.
    await providerTransaction(this.pool, async db => {
      const row = (await db.query<{ amount_cents: number; payment_intent: string }>(
        'SELECT amount_cents,payment_intent FROM app_equipment_checkout WHERE reservation_id=$1 AND refund_reconcile_after IS NOT NULL FOR UPDATE',
        [id])).rows[0];
      if (!row) return;
      const refunds = await this.provider().sdk.refunds.list({ payment_intent: row.payment_intent, limit: 100 });
      try {
        const refund = liveRefund(refunds, row.amount_cents);
        if (refund) await this.applyRefund(db, refund);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'RECONCILE_REQUIRED') throw error;
        console.error('Equipment refund requires staff reconciliation', {
          reservationId: id, stage: 'equipment_reconcile_refund', ...errorIdentifier(error),
        });
      }
      await db.query('UPDATE app_equipment_checkout SET refund_reconcile_after=NULL,refund_checked_at=now() WHERE reservation_id=$1', [id]);
    });
  }

  private async reconcileRefunds() {
    // Catch paid writes from older app processes even after the online backfill has
    // finished. A checked row leaves this index, including when Stripe has no refund.
    await this.pool.query(`WITH unchecked AS (
      SELECT reservation_id FROM app_equipment_checkout WHERE status='paid'
        AND payment_id IS NOT NULL AND payment_intent IS NOT NULL AND refund_id IS NULL
        AND refund_reconcile_after IS NULL AND refund_checked_at IS NULL
      ORDER BY reservation_id LIMIT 20 FOR UPDATE SKIP LOCKED
    ) UPDATE app_equipment_checkout c SET refund_reconcile_after=now()
    FROM unchecked WHERE c.reservation_id=unchecked.reservation_id`);
    // Claim a bounded batch across replicas; an unsuccessful attempt will be due again in a minute.
    const rows = (await this.pool.query<{ reservation_id: number }>(`WITH due AS (
      SELECT reservation_id FROM app_equipment_checkout WHERE refund_reconcile_after<=now()
      ORDER BY refund_reconcile_after LIMIT 20 FOR UPDATE SKIP LOCKED
    ) UPDATE app_equipment_checkout c SET refund_reconcile_after=now()+interval '1 minute'
    FROM due WHERE c.reservation_id=due.reservation_id RETURNING c.reservation_id`)).rows;
    await Promise.all(rows.map(({reservation_id}) => this.reconcileRefund(reservation_id).catch(error =>
      console.error('Equipment refund reconciliation deferred', {reservationId: reservation_id, ...errorIdentifier(error)}))));
  }

  /**
   * Refresh the payer's pending checkouts from the provider so a missed callback does not leave
   * stale booking state.
   */
  async reconcile(payerId?: number) {
    // Holds whose checkout was never opened can't be checked with Stripe; release them once they pass.
    const unopened = (await this.pool.query(`SELECT reservation_id FROM app_equipment_checkout
      WHERE status='pending' AND checkout_id IS NULL AND hold_until<=now() ORDER BY hold_until LIMIT 20`)).rows;
    for (const row of unopened)
      await this.expireUnopened(row.reservation_id, 'Unpaid checkout expired', true).catch(error =>
        console.error('Equipment payment reconciliation deferred', {reservationId: row.reservation_id, stage: 'equipment_expire_unopened',
          ...errorIdentifier(error)}));
    if (!this.stripe) return;
    // A member's own checkouts are always checked. Other expired holds wait out their backoff after a
    // failure, and ones that have never failed go first, so a few stuck checkouts can't fill every slot.
    const rows = (await this.pool.query(`SELECT reservation_id,checkout_id FROM app_equipment_checkout
      WHERE status='pending' AND checkout_id IS NOT NULL AND
      (payer_id=$1 OR reservation_id IN (SELECT reservationid FROM reservation WHERE userid=$1)
        OR hold_until <= now() AND (reconcile_after IS NULL OR reconcile_after <= now()))
      ORDER BY (payer_id=$1) DESC NULLS LAST,reconcile_failures,hold_until LIMIT 20`, [payerId ?? null])).rows;
    await Promise.all(rows.map(async row => {
      try {
        const session = await this.stripe!.sdk.checkout.sessions.retrieve(row.checkout_id);
        if (session.id !== row.checkout_id || session.metadata?.equipmentReservationId !== String(row.reservation_id))
          throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment checkout identity mismatch.');
        await this.apply(session);
      } catch (error) {
        // Keep the hold during provider outages; browsing stays available and a
        // later read or signed callback can finish verification safely. Log only the
        // error class and PostgreSQL SQLSTATE or Stripe error type, never messages or bodies.
        console.error('Equipment payment reconciliation deferred', {reservationId: row.reservation_id, stage: 'equipment_reconcile',
          ...errorIdentifier(error)});
        // Wait longer after each failure (1 minute, doubling, at most an hour) before the next background check.
        await this.pool.query(`UPDATE app_equipment_checkout SET reconcile_failures=reconcile_failures+1,
          reconcile_after=now()+LEAST(interval '1 hour',interval '1 minute'*power(2,LEAST(reconcile_failures,6)))
          WHERE reservation_id=$1 AND status='pending'`, [row.reservation_id]).catch(() => undefined);
      }
    }));
    if (payerId === undefined) await this.reconcileRefunds();
  }

  /** Expire an unpaid checkout through the provider before releasing its local booking/payment state. */
  async cancelPending(payerId: number, id: number) {
    const row = (await this.pool.query('SELECT * FROM app_equipment_checkout WHERE reservation_id=$1 AND payer_id=$2', [id, payerId])).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Checkout not found.');
    if (row.status !== 'pending') throw new AppError(409, 'PAYMENT_PROCESSING', 'Refresh the reservation before cancelling.');
    if (!row.checkout_id) {
      if (await this.expireUnopened(id, 'Unpaid checkout expired', true)) return { cancelled: true };
      throw new AppError(409, 'RECONCILE_REQUIRED', 'Resume checkout before cancelling it.');
    }
    const sdk = this.provider().sdk;
    let session = await sdk.checkout.sessions.retrieve(row.checkout_id);
    if (session.status === 'open') session = await sdk.checkout.sessions.expire(session.id);
    await this.apply(session);
    if (session.status !== 'expired') throw new AppError(409, 'PAYMENT_PROCESSING', 'Payment is being verified. Refresh before cancelling.');
    return { cancelled: true };
  }

  /**
   * Staff refund of a card-paid booking to the original card. The key names the booking, so a
   * repeated click reuses the same Stripe refund; the booking itself is left as it is.
   */
  async refund(actor: number, id: number, reason: unknown) {
    const explanation = textField(reason, 'Refund reason', 255, 3), sdk = this.provider().sdk;
    return providerTransaction(this.pool, async db => {
      const operator = await requireActor(db, actor, { staff: true });
      const row = (await db.query<RefundableCheckout>(`SELECT c.*,r.userid FROM app_equipment_checkout c
        JOIN reservation r ON r.reservationid=c.reservation_id WHERE c.reservation_id=$1 FOR UPDATE OF c`, [id])).rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Equipment payment not found.');
      // The booking stays confirmed and Stripe refunds the payer's card. Protect both accounts.
      if (row.userid === actor || row.payer_id === actor)
        throw new AppError(403, 'SELF_CHANGE_FORBIDDEN', 'Another administrator must refund a payment on your own account.');
      await assertManageable(db, operator, row.userid);
      if (row.payer_id !== row.userid) await assertManageable(db, operator, row.payer_id);
      if (row.refund_status === 'succeeded') return { status: 'succeeded' };
      if (row.status !== 'paid' || !row.payment_intent || !row.payment_id)
        throw new AppError(409, 'NOT_PAID', 'Only a booking paid by card can be refunded.');
      const previous = await sdk.refunds.list({ payment_intent: row.payment_intent, limit: 100 });
      // A failed attempt returned nothing, so a retry submits a new refund rather than reusing it.
      const attempt = refundAttempt('equipment-refund:' + id, previous);
      const refund = liveRefund(previous, row.amount_cents) ?? await sdk.refunds.create({ payment_intent: row.payment_intent,
        amount: row.amount_cents, ...(attempt.metadata ? { metadata: attempt.metadata } : {}) }, { idempotencyKey: attempt.key });
      await this.applyRefund(db, refund);
      await new StaffModel(db).audit(actor, row.userid, 'billing.refund.requested', 'payment', row.payment_id, explanation, null,
        { refundId: refund.id, status: refund.status });
      return { status: refund.status };
    });
  }

  /** Record a Stripe refund of a booking's payment; stale and repeated updates are skipped as for day passes. */
  async applyRefund(db: Database, refund: Stripe.Refund) {
    const row = (await db.query<RefundableCheckout>(`SELECT c.*,r.userid FROM app_equipment_checkout c
      JOIN reservation r ON r.reservationid=c.reservation_id WHERE c.payment_intent=$1 FOR UPDATE OF c`, [objectId(refund.payment_intent)])).rows[0];
    if (!row) return;
    const recorded = { refundId: row.refund_id, refundStatus: row.refund_status };
    if (refundTransition(recorded, refund) === 'skip' || replacedAttemptFailed(recorded, refund)) return;
    if (refund.amount !== row.amount_cents || refund.currency !== 'usd')
      throw new AppError(409, 'RECONCILE_REQUIRED', 'Refund does not match the original booking payment.');
    await db.query('UPDATE app_equipment_checkout SET refund_id=$2,refund_status=$3 WHERE reservation_id=$1', [row.reservation_id, refund.id, refund.status]);
    const notice = `equipment-refund:${row.reservation_id}`;
    if (refund.status === 'succeeded') {
      await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1", [row.payment_id]);
      // The money goes back to the payer's card, so they get the notice, as they got the receipt.
      await enqueueNotification(db, { userId: row.payer_id, kind: 'payment_refunded', dedupeKey: `${notice}:${refund.id}`,
        payload: { reference: refund.id, amount: (refund.amount / 100).toFixed(2), currency: 'USD', method: paymentLabels(modeOf(this.stripe)).originalCard,
          reservationId: row.reservation_id } });
    }
    if (failedRefund(refund)) {
      // The charge stays paid: the attempted refund returned nothing.
      await db.query("UPDATE payment SET paymentstatus='paid',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus='refunded'", [row.payment_id]);
      await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=ANY($1::text[]) AND status='pending'",
        [[notice, `${notice}:${refund.id}`]]);
      await enqueueNotification(db, { userId: row.payer_id, kind: 'payment_status_changed', dedupeKey: `equipment-refund-failed:${row.reservation_id}:${refund.id}`,
        payload: { paymentId: row.payment_id, reservationId: row.reservation_id, reference: refund.id,
          instructions: 'The original-card refund for your equipment booking did not go through. Contact staff to complete it.' } });
    }
  }

  /** A refund made in Stripe, by staff here or in the Stripe dashboard, is recorded against the booking it paid for. */
  private async refundEvent(event: RefundEvent) {
    const intent = objectId(event.data.object.payment_intent);
    if (!intent) return;
    const known = (await this.pool.query('SELECT reservation_id FROM app_equipment_checkout WHERE payment_intent=$1', [intent])).rows[0];
    if (!known) return;
    assertStripeMode(modeOf(this.stripe), event.livemode);
    const sdk = this.provider().sdk;
    await providerTransaction(this.pool, async db => {
      // Retrieve while the checkout is locked, so a stale delivery can't apply an older state after a newer one.
      await db.query('SELECT reservation_id FROM app_equipment_checkout WHERE payment_intent=$1 FOR UPDATE', [intent]);
      const refund = await sdk.refunds.retrieve(event.data.object.id);
      if (refund.id !== event.data.object.id || objectId(refund.payment_intent) !== intent)
        throw new AppError(400, 'PAYMENT_MISMATCH', 'Refund identity mismatch.');
      await this.applyRefund(db, refund);
    });
  }

  /**
   * Dispatch relevant verified provider events through reconciliation instead of trusting browser
   * return parameters.
   */
  async webhook(event: Stripe.Event) {
    if (isRefundEvent(event)) return this.refundEvent(event);
    if (!['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) return;
    const object = event.data.object as Stripe.Checkout.Session;
    const known = (await this.pool.query(`SELECT reservation_id FROM app_equipment_checkout
      WHERE checkout_id=$1 OR reservation_id::text=$2`, [object.id, object.metadata?.equipmentReservationId ?? ''])).rows[0];
    if (!known) return;
    assertStripeMode(modeOf(this.stripe), event.livemode);
    const session = await this.provider().sdk.checkout.sessions.retrieve(object.id);
    if (session.id !== object.id || session.metadata?.equipmentReservationId !== String(known.reservation_id))
      throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment checkout identity mismatch.');
    await this.apply(session);
  }
}
