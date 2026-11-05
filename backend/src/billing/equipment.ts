import type { Pool } from 'pg';
import Stripe from 'stripe';
import { transaction } from '../db.js';
import { AppError } from '../domain.js';
import { ReservationModel } from '../models/ReservationModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { enqueueNotification } from '../notifications/store.js';
import { StudioStripe } from '../studios/stripe.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { AccessService } from '../services/AccessService.js';
import type { Database } from '../db.js';

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

  async checkout(payerId: number, id: number) {
    const row = (await this.pool.query(`SELECT c.*,r.userid,r.equipmentid,r.endtime AT TIME ZONE 'UTC' AS "endsAt" FROM app_equipment_checkout c
      JOIN reservation r ON r.reservationid=c.reservation_id
      WHERE c.reservation_id=$1 AND c.payer_id=$2`, [id, payerId])).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Checkout not found.');
    if (row.status === 'expired') throw new AppError(409, 'CHECKOUT_EXPIRED', 'Payment time expired. Choose your time again.');
    if (row.status !== 'pending') return { ...await new ReservationModel(this.pool).find(id), amountCents: row.amount_cents };
    // Recheck the booked member, including staff-assisted and idempotent retries.
    // A checkout link must never bypass a waiver revoked after the initial hold.
    await transaction(this.pool, db => this.requirements(db, row));
    const provider = this.provider();
    // An ambiguous create response must reuse the original key, never charge again.
    if (!row.checkout_id && Date.now() - new Date(row.created_at).getTime() > 23 * 3600000)
      throw new AppError(409, 'RECONCILE_REQUIRED', 'Staff must reconcile this checkout before another payment.');
    let session: Stripe.Checkout.Session;
    try {
      session = row.checkout_id
      ? await provider.sdk.checkout.sessions.retrieve(row.checkout_id)
      : await provider.sdk.checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'],
        integration_identifier: 'arbor-equipment-checkout',
        client_reference_id: String(id), metadata: { equipmentReservationId: String(id) },
        payment_intent_data: { metadata: { equipmentReservationId: String(id) } },
        expires_at: Math.floor(new Date(row.hold_until).getTime() / 1000),
        success_url: provider.config.origin + `/equipment?payment=returned&reservation=${id}`,
        cancel_url: provider.config.origin + `/equipment?payment=cancelled&reservation=${id}`,
        line_items: [{ quantity: row.hours, price_data: { currency: 'usd', unit_amount: row.hourly_cents,
          product_data: { name: `${row.equipment_name} — hourly reservation` } } }],
      }, { idempotencyKey: `equipment-checkout:${id}` });
    } catch (error) {
      // A definite validation rejection created no checkout. Ambiguous network errors
      // keep the hold and its idempotency key so a retry cannot charge twice.
      if (!row.checkout_id && error instanceof Stripe.errors.StripeInvalidRequestError)
        await transaction(this.pool, async db => {
          await db.query('SELECT reservationid FROM reservation WHERE reservationid=$1 FOR UPDATE', [id]);
          const expired = await db.query("UPDATE app_equipment_checkout SET status='expired' WHERE reservation_id=$1 AND status='pending' AND checkout_id IS NULL RETURNING reservation_id", [id]);
          if (expired.rowCount) {
            await db.query("UPDATE reservation SET status='cancelled',statusdesc='Checkout creation rejected' WHERE reservationid=$1 AND status='pending'", [id]);
            await db.query("UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now() WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1) AND paymentstatus='pending'", [id]);
          }
        });
      throw new AppError(503, 'CHECKOUT_UNAVAILABLE', 'Stripe checkout could not be opened. Refresh your reservations and resume payment to try again.');
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

  async apply(session: Stripe.Checkout.Session) {
    const id = session.metadata?.equipmentReservationId;
    if (!id) return;
    await transaction(this.pool, async db => {
      // Reservation first: use the same lock order as staff edits/cancellations.
      const reservation = (await db.query(`SELECT *,endtime AT TIME ZONE 'UTC' AS "endsAt" FROM reservation WHERE reservationid::text=$1 FOR UPDATE`, [id])).rows[0];
      const row = (await db.query('SELECT * FROM app_equipment_checkout WHERE reservation_id::text=$1 FOR UPDATE', [id])).rows[0];
      if (!row || !reservation) return;
      if (session.livemode || session.mode !== 'payment' || session.client_reference_id !== id ||
        row.checkout_id && session.id !== row.checkout_id || session.amount_total !== row.amount_cents || session.currency !== 'usd')
        throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment payment does not match this reservation.');
      if (row.status !== 'pending') return;
      if (session.status === 'expired' && session.payment_status === 'unpaid') {
        await db.query("UPDATE app_equipment_checkout SET status='expired',checkout_id=$2 WHERE reservation_id=$1", [id, session.id]);
        await db.query("UPDATE reservation SET status='cancelled',statusdesc='Unpaid checkout expired' WHERE reservationid=$1 AND status='pending'", [id]);
        await db.query("UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now() WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1) AND paymentstatus='pending'", [id]);
        return;
      }
      if (session.status !== 'complete' || session.payment_status !== 'paid') return;
      const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!intent || reservation.status !== 'pending') throw new AppError(409, 'RECONCILE_REQUIRED', 'Payment requires staff reconciliation.');
      // Payment alone cannot confirm a booking whose current waivers/training
      // are invalid. The same paid session can reconcile after eligibility is restored.
      await this.requirements(db, reservation);
      const model = new StaffModel(db);
      const existingPayment = (await db.query(`UPDATE payment SET paymentstatus='paid',method='card',reference=$2,
        note='Online equipment reservation (Stripe test mode)',revision=revision+1,updated_at=now()
        WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1)
          AND userid=$3 AND paymentstatus='pending' RETURNING paymentid AS id`, [id, session.id, reservation.userid])).rows[0];
      const payment = existingPayment?.id ?? await model.createPayment(reservation.userid, null, (row.amount_cents / 100).toFixed(2),
        'paid', 'card', session.id, 'Online equipment reservation (Stripe test mode)', row.payer_id);
      await db.query("UPDATE app_equipment_checkout SET status='paid',checkout_id=$2,payment_intent=$3,payment_id=$4 WHERE reservation_id=$1", [id, session.id, intent, payment]);
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
          currency: 'USD', method: 'Card (test mode)', reference: session.id } });
    });
  }

  async reconcile(payerId?: number) {
    if (!this.stripe) return;
    const rows = (await this.pool.query(`SELECT reservation_id,checkout_id FROM app_equipment_checkout
      WHERE status='pending' AND checkout_id IS NOT NULL AND
      (hold_until <= now() OR payer_id=$1 OR reservation_id IN (SELECT reservationid FROM reservation WHERE userid=$1))
      ORDER BY (payer_id=$1) DESC NULLS LAST,hold_until LIMIT 20`, [payerId ?? null])).rows;
    await Promise.all(rows.map(async row => {
      try {
        const session = await this.stripe!.sdk.checkout.sessions.retrieve(row.checkout_id);
        if (session.id !== row.checkout_id || session.metadata?.equipmentReservationId !== String(row.reservation_id))
          throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment checkout identity mismatch.');
        await this.apply(session);
      } catch {
        // Keep the hold during provider outages; browsing stays available and a
        // later read or signed callback can finish verification safely.
        console.error('Equipment payment reconciliation deferred', {reservationId: row.reservation_id});
      }
    }));
  }

  async cancelPending(payerId: number, id: number) {
    const row = (await this.pool.query('SELECT * FROM app_equipment_checkout WHERE reservation_id=$1 AND payer_id=$2', [id, payerId])).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Checkout not found.');
    if (row.status !== 'pending') throw new AppError(409, 'PAYMENT_PROCESSING', 'Refresh the reservation before cancelling.');
    if (!row.checkout_id) throw new AppError(409, 'RECONCILE_REQUIRED', 'Resume checkout before cancelling it.');
    const sdk = this.provider().sdk;
    let session = await sdk.checkout.sessions.retrieve(row.checkout_id);
    if (session.status === 'open') session = await sdk.checkout.sessions.expire(session.id);
    await this.apply(session);
    if (session.status !== 'expired') throw new AppError(409, 'PAYMENT_PROCESSING', 'Payment is being verified. Refresh before cancelling.');
    return { cancelled: true };
  }

  async webhook(event: Stripe.Event) {
    if (!['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) return;
    const object = event.data.object as Stripe.Checkout.Session;
    const known = (await this.pool.query(`SELECT reservation_id FROM app_equipment_checkout
      WHERE checkout_id=$1 OR reservation_id::text=$2`, [object.id, object.metadata?.equipmentReservationId ?? ''])).rows[0];
    if (!known) return;
    if (event.livemode) throw new AppError(400, 'LIVE_PAYMENT_FORBIDDEN', 'Test payments only.');
    const session = await this.provider().sdk.checkout.sessions.retrieve(object.id);
    if (session.id !== object.id || session.metadata?.equipmentReservationId !== String(known.reservation_id))
      throw new AppError(400, 'PAYMENT_MISMATCH', 'Equipment checkout identity mismatch.');
    await this.apply(session);
  }
}
