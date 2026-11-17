import type { Pool } from 'pg';
import { waiverFormFields, type WaiverFormField } from '../../src/waiverForms.js';

/**
 * Signed copies are permanent, so deleting a signature that has one is refused. Fixtures that
 * reset signatures, or recreate copies from before the lock, run their SQL with the lock lifted
 * for that one transaction. The application never does this.
 */
export async function withSignedCopiesUnlocked(pool: Pool, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE app_signed_waiver_copy DISABLE TRIGGER app_signed_waiver_copy_permanent');
    await client.query(sql, params);
    await client.query('ALTER TABLE app_signed_waiver_copy ENABLE TRIGGER app_signed_waiver_copy_permanent');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const equipmentWaiverName = 'Specialized Equipment Use – Acknowledgment of Risk, Release & Safety Agreement';

/**
 * Build complete acceptance values from the policy definition so fixtures exercise the same
 * required-field contract as member submissions.
 */
export function waiverAcceptance(waiver: { description?: string; formFields?: WaiverFormField[]; signerName?: string }, guardianConsent = false) {
  const fields = waiver.formFields ?? waiverFormFields(waiver.description ?? '');
  if (!fields.length) return { accepted: true };
  // The server fills identity, version and signing time; the signature must match the account.
  const signer = waiver.signerName ?? 'Waiver Test Participant';
  const formValues = Object.fromEntries(fields.filter(field => field.source === 'member').map(field => {
    const value = !field.required ? ''
      : field.section === 'participant' && /signature/i.test(field.label) ? signer
      : /date of birth/i.test(field.label) ? '2000-01-01'
      : field.type === 'date' ? '2026-10-27'
      : field.type === 'email' ? 'waiver-test@example.invalid'
      : field.type === 'tel' ? '+1 (555) 010-1234'
      : /relationship/i.test(field.label) ? 'Parent' : 'Waiver Test Participant';
    return [field.key, value];
  }));
  return { accepted: true, formValues, guardianConsent };
}
