import { AppError } from './domain.js';

/** Client rule: waivers and certifications last 365 days from each person's signing or training. */
export const ANNUAL_VALIDITY_DAYS = 365;
export const ANNUAL_VALIDITY_MS = ANNUAL_VALIDITY_DAYS * 86_400_000;

/**
 * Older clients still send `validityDays`. Accept nothing (or the annual value) and
 * refuse anything else, so a caller asking for another period is told rather than ignored.
 */
export function annualValidity(value: unknown, label: string) {
  if (value == null || value === '' || value === ANNUAL_VALIDITY_DAYS) return ANNUAL_VALIDITY_DAYS;
  throw new AppError(400, 'INVALID_INPUT', `${label} are valid for ${ANNUAL_VALIDITY_DAYS} days after each person completes them.`);
}
