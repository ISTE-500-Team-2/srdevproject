import { waiverFormFields, type WaiverFormField } from '../../src/waiverForms.js';

export const equipmentWaiverName = 'Specialized Equipment Use – Acknowledgment of Risk, Release & Safety Agreement';

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
