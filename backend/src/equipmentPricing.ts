import type { Database } from './db.js';
import { AppError } from './domain.js';
import { StaffModel } from './models/StaffModel.js';
import { auditContext } from './auditContext.js';

export interface EquipmentPrice {
  currency: 'USD'; hours: number; hourlyRateCents: number; equipmentCents: number;
  trainingFeeCents: number; totalCents: number; certificationId: number | null;
  certificationRevision: number | null;
}

export async function equipmentPrice(db: Database, equipmentId: number, hours: number): Promise<EquipmentPrice | null> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 24)
    throw new AppError(400, 'INVALID_INPUT', 'Choose 1–24 whole hours.');
  const row = (await db.query(`SELECT round(e.hourlyrate*100)::int AS rate,e.certid,c.revision
    FROM equipment e LEFT JOIN certifications c USING(certid)
    WHERE e.equipmentid=$1`, [equipmentId])).rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
  if (row.rate === null) {
    return null; // Preserve existing unpriced legacy bookings; never invent a zero rate.
  }
  const total = row.rate * hours;
  if (!Number.isSafeInteger(total) || total < 0 || total > 10000000)
    throw new AppError(409, 'INVALID_PRICE', 'The booking amount is outside the supported range.');
  return { currency: 'USD', hours, hourlyRateCents: row.rate, equipmentCents: row.rate * hours,
    // Retain this field for historical reservation snapshots and older clients.
    trainingFeeCents: 0, totalCents: total, certificationId: row.certid, certificationRevision: row.revision };
}

export function reviewEquipmentPrice(current: EquipmentPrice | null, expected: unknown) {
  if (expected === undefined && !current?.trainingFeeCents) return; // Older clients remain usable for ordinary bookings.
  if (!current || !expected || typeof expected !== 'object' ||
      Object.entries(current).some(([key, value]) => (expected as Record<string, unknown>)[key] !== value))
    throw new AppError(409, 'PRICE_CHANGED', 'The booking price changed. Refresh and review the breakdown before confirming.');
}

export async function saveReservationPrice(db: Database, reservationId: number, userId: number,
  actorId: number, price: EquipmentPrice | null, name: string) {
  const before = (await db.query('SELECT payment_id,price_snapshot FROM reservation WHERE reservationid=$1 FOR UPDATE', [reservationId])).rows[0];
  if (!before) throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
  const payment = before.payment_id ? await new StaffModel(db).payment(before.payment_id) : null;
  const amount = price ? (price.totalCents / 100).toFixed(2) : null;
  if (payment?.status === 'paid') {
    if (payment.userId !== userId || payment.amount !== amount)
      throw new AppError(409, 'PAYMENT_SETTLED', 'This booking has a settled payment. Record the appropriate refund before changing its price or member.');
  } else if (payment?.status === 'pending') {
    if (amount === null) throw new AppError(409, 'PRICE_NOT_CONFIGURED', 'Configure a price before moving a billed booking.');
    await db.query(`UPDATE payment SET userid=$2,price=$3,paymentstatus=$4,revision=revision+1,updated_at=now()
      WHERE paymentid=$1`, [payment.id, userId, amount, price!.totalCents === 0 ? 'waived' : 'pending']);
  }
  let paymentId = payment?.id ?? null;
  if (price && (!payment || ['void', 'refunded'].includes(payment.status) ||
      payment.status === 'waived' && (payment.userId !== userId || before.price_snapshot?.totalCents !== price.totalCents))) {
    paymentId = await new StaffModel(db).createPayment(userId, null, amount!, price.totalCents ? 'pending' : 'waived',
      'unspecified', '', `Equipment booking: ${name}; equipment ${(price.equipmentCents/100).toFixed(2)} USD`, auditContext.getStore()?.actorId ?? actorId);
  }
  await db.query('UPDATE reservation SET price_snapshot=$2,payment_id=$3 WHERE reservationid=$1',
    [reservationId, price ? JSON.stringify(price) : null, paymentId]);
}

export async function cancelReservationPayment(db: Database, reservationId: number) {
  // External payments are refunded explicitly by staff; cancellation never claims a refund was sent.
  await db.query(`UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now()
    WHERE paymentid=(SELECT payment_id FROM reservation WHERE reservationid=$1) AND paymentstatus='pending'`, [reservationId]);
}
