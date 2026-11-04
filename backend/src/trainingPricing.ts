import type { Database } from './db.js';
import { AppError } from './domain.js';
import { StaffModel } from './models/StaffModel.js';

// Completion or a settled training charge covers this certification permanently.
// Expiry/revocation can require retraining without making someone a new user.
export function trainingFeeCoveredSql(user: string, cert: string) {
  return `(EXISTS (SELECT 1 FROM user_certifications uc WHERE uc.userid=${user} AND uc.certid=${cert}
      AND (uc.status='active' OR uc.approved_by IS NOT NULL))
    OR EXISTS (SELECT 1 FROM app_training_enrollment e JOIN app_training_class tc ON tc.id=e.class_id
      JOIN payment tp ON tp.paymentid=e.payment_id WHERE e.user_id=${user} AND tc.certification_id=${cert}
      AND e.training_fee_cents>0 AND tp.paymentstatus IN ('paid','waived')))`;
}

export async function enrollTrainingPayment(db: Database, tz: string, userId: number,
  course: { id: number; certification_id: number; title: string },
  before: { payment_id: number | null; training_fee_cents: number | null } | undefined,
  expectedFee: unknown) {
  const staff = new StaffModel(db, tz);
  const payment = before?.payment_id ? await staff.payment(before.payment_id) : null;
  // Rejoining a paid registration must not create another charge.
  if (payment && ['paid', 'waived'].includes(payment.status))
    return { fee: before!.training_fee_cents ?? 0, paymentId: payment.id as number };
  const cert = (await db.query<{ training_fee_cents: number | null; covered: boolean }>(
    `SELECT training_fee_cents,${trainingFeeCoveredSql('$2', 'cert.certid')} AS covered
      FROM certifications cert WHERE certid=$1 FOR SHARE`, [course.certification_id, userId])).rows[0];
  if (!cert) throw new AppError(404, 'NOT_FOUND', 'Training certification not found.');
  const fee = cert.covered ? 0 : cert.training_fee_cents;
  if (fee === null)
    throw new AppError(409, 'PRICE_NOT_CONFIGURED', 'Staff must configure the training fee before registration.');
  // Serialize enrollments for this user before checking this pending charge.
  // A second unpaid registration must not create a duplicate training bill.
  if (fee && (await db.query(`SELECT 1 FROM app_training_enrollment e
    JOIN app_training_class c ON c.id=e.class_id JOIN payment p ON p.paymentid=e.payment_id
    WHERE e.user_id=$1 AND c.certification_id=$2 AND p.paymentstatus='pending'
      AND e.training_fee_cents>0 LIMIT 1`, [userId, course.certification_id])).rowCount)
    throw new AppError(409, 'TRAINING_PAYMENT_PENDING', 'You already have an unpaid training registration for this equipment. Settle or withdraw that registration before booking another training class.');
  if (expectedFee !== fee && !(expectedFee === undefined && fee === 0))
    throw new AppError(409, 'PRICE_CHANGED', 'The training fee changed. Refresh and review the fee before registering.');
  const paymentId = fee ? await staff.createPayment(userId, null, (fee / 100).toFixed(2),
    'pending', 'unspecified', '', `Training class: ${course.title}; one-time training fee ${(fee / 100).toFixed(2)} USD`, userId) : null;
  return { fee, paymentId };
}

export async function cancelTrainingPayments(db: Database, classId: number, userId?: number) {
  // Paid registrations remain visible for staff to refund explicitly.
  await db.query(`UPDATE payment SET paymentstatus='void',revision=revision+1,updated_at=now()
    WHERE paymentid IN (SELECT payment_id FROM app_training_enrollment WHERE class_id=$1
      AND ($2::int IS NULL OR user_id=$2)) AND paymentstatus='pending'`, [classId, userId ?? null]);
}
