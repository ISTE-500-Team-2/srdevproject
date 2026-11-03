import type { Database } from './db.js';
import { AppError } from './domain.js';
import { EligibilityModel } from './models/EligibilityModel.js';
import { StaffModel } from './models/StaffModel.js';

export async function enrollTrainingPayment(db: Database, tz: string, userId: number,
  course: { id: number; certification_id: number; title: string },
  before: { payment_id: number | null; training_fee_cents: number | null } | undefined,
  expectedFee: unknown) {
  const staff = new StaffModel(db, tz);
  const payment = before?.payment_id ? await staff.payment(before.payment_id) : null;
  // Rejoining a paid registration must not create another charge.
  if (payment && ['paid', 'waived'].includes(payment.status))
    return { fee: before!.training_fee_cents ?? 0, paymentId: payment.id as number };
  const cert = (await db.query<{ training_fee_cents: number | null }>('SELECT training_fee_cents FROM certifications WHERE certid=$1 FOR SHARE',
    [course.certification_id])).rows[0];
  if (!cert) throw new AppError(404, 'NOT_FOUND', 'Training certification not found.');
  const certified = await new EligibilityModel(db, tz).certification(userId, course.certification_id, new Date());
  const fee = certified ? 0 : cert.training_fee_cents;
  if (fee === null)
    throw new AppError(409, 'PRICE_NOT_CONFIGURED', 'Staff must configure the training fee before registration.');
  if (expectedFee !== fee && !(expectedFee === undefined && fee === 0))
    throw new AppError(409, 'PRICE_CHANGED', 'The training fee changed. Refresh and review the fee before registering.');
  const paymentId = fee ? await staff.createPayment(userId, null, (fee / 100).toFixed(2),
    'pending', 'unspecified', '', `Training class: ${course.title}; training fee ${(fee / 100).toFixed(2)} USD`, userId) : null;
  return { fee, paymentId };
}

export async function cancelTrainingPayments(db: Database, classId: number, userId?: number) {
  // Paid registrations remain visible for staff to refund explicitly.
  await db.query(`UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now()
    WHERE paymentid IN (SELECT payment_id FROM app_training_enrollment WHERE class_id=$1
      AND ($2::int IS NULL OR user_id=$2)) AND paymentstatus='pending'`, [classId, userId ?? null]);
}
