import { AppError, dateOfBirthField, emailField, textField } from './domain.js';

export interface WaiverFormField {
  key: string;
  label: string;
  line: number;
  type: 'text' | 'date' | 'datetime-local' | 'email' | 'tel';
  section: 'participant' | 'guardian' | 'administrative';
  required: boolean;
  maxLength: number;
}

// Derive a separate input for every blank, including repeated names and dates.
// Existing database documents work without a form key or additional migration.
export function waiverFormFields(description: string): WaiverFormField[] {
  const fields: WaiverFormField[] = [];
  let section: WaiverFormField['section'] = 'participant';
  description.split(/\r?\n/).forEach((line, lineNumber) => {
    if (/^Parent or Legal Guardian Consent\s*$/i.test(line)) section = 'guardian';
    if (/^Administrative Record\s*$/i.test(line)) section = 'administrative';
    let previousEnd = 0;
    for (const blank of line.matchAll(/_{3,}/g)) {
      const label = line.slice(previousEnd, blank.index).trim().replace(/:\s*$/, '') || `Field ${fields.length + 1}`;
      const type = /date\/time/i.test(label) ? 'datetime-local'
        : /^(date|date of birth)$/i.test(label) ? 'date'
        : /email/i.test(label) ? 'email'
        : /phone/i.test(label) ? 'tel' : 'text';
      fields.push({ key: `field_${fields.length + 1}`, label, line: lineNumber, type, section,
        required: !/if applicable/i.test(label), maxLength: type === 'email' ? 100 : type === 'tel' ? 40 : 200 });
      previousEnd = blank.index + blank[0].length;
    }
  });
  return fields;
}

export function validateWaiverFields(description: string, raw: unknown, guardianConsent: unknown) {
  const fields = waiverFormFields(description);
  if (!fields.length) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AppError(400, 'WAIVER_FORM_REQUIRED', 'Complete the waiver form before signing.');
  if (typeof guardianConsent !== 'boolean')
    throw new AppError(400, 'INVALID_INPUT', 'Specify whether guardian consent is included.');
  const input = raw as Record<string, unknown>;
  const allowed = new Set(fields.map(f => f.key));
  if (Object.keys(input).some(key => !allowed.has(key)))
    throw new AppError(400, 'INVALID_INPUT', 'The waiver contains an unrecognized form field.');
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.section === 'guardian' && !guardianConsent) continue;
    const value = input[field.key];
    if (!field.required && (value === undefined || (typeof value === 'string' && !value.trim()))) {
      values[field.key] = '';
      continue;
    }
    const text = textField(value, field.label, field.maxLength);
    if (/[\u0000-\u001f\u007f]/.test(text))
      throw new AppError(400, 'INVALID_INPUT', `${field.label} must be a single line.`);
    if (field.type === 'email') values[field.key] = emailField(text);
    else if (field.type === 'date' || field.type === 'datetime-local') {
      const isDate = field.type === 'date';
      const format = isDate ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
      const date = new Date(isDate ? `${text}T00:00:00Z` : `${text}:00Z`);
      if (!format.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, isDate ? 10 : 16) !== text)
        throw new AppError(400, 'INVALID_INPUT', `Enter a valid ${field.label.toLowerCase()}.`);
      values[field.key] = /^date of birth$/i.test(field.label) ? dateOfBirthField(text) : text;
    } else {
      if (field.type === 'tel' && (!/^\+?[\d\s().\-xext]{7,40}$/i.test(text) || text.replace(/\D/g, '').length < 7))
        throw new AppError(400, 'INVALID_INPUT', `Enter a valid ${field.label.toLowerCase()}.`);
      values[field.key] = text;
    }
  }
  return { values, guardianConsent };
}

export function completedWaiverText(description: string, values: Record<string, string>, guardianConsent: boolean) {
  const fields = waiverFormFields(description);
  let slot = 0;
  return description.replace(/_{3,}/g, () => {
    const field = fields[slot++]!;
    return field.section === 'guardian' && !guardianConsent
      ? 'Not provided (guardian consent not included)' : values[field.key] || 'Not provided';
  }).replace('Method of Acceptance: ☐ Electronic ☐ In Person ☐ Other', 'Method of Acceptance: ☑ Electronic ☐ In Person ☐ Other');
}
