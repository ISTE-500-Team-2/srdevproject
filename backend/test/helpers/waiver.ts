import { waiverFormFields, type WaiverFormField } from '../../src/waiverForms.js';

export const equipmentWaiverName = 'Specialized Equipment Use – Acknowledgment of Risk, Release & Safety Agreement';

export function waiverAcceptance(waiver: { description?: string; formFields?: WaiverFormField[] }, guardianConsent = false) {
  const fields = waiver.formFields ?? waiverFormFields(waiver.description ?? '');
  if (!fields.length) return { accepted: true };
  const formValues = Object.fromEntries(fields.map(field => {
    const value = !field.required ? ''
      : /date of birth/i.test(field.label) ? '2000-01-01'
      : field.type === 'date' ? '2026-10-27'
      : field.type === 'datetime-local' ? '2026-10-27T12:00'
      : field.type === 'email' ? 'waiver-test@example.invalid'
      : field.type === 'tel' ? '+1 (555) 010-1234'
      : /waiver version/i.test(field.label) ? '2026-10-27'
      : /user\/member id/i.test(field.label) ? '123'
      : /relationship/i.test(field.label) ? 'Parent' : 'Waiver Test Participant';
    return [field.key, value];
  }));
  return { accepted: true, formValues, guardianConsent };
}
