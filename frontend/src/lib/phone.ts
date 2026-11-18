// Phone numbers as members type them. Formatting is welcome while typing; sign-up and the profile's
// Contact form (phoneToSave in ProfilePage) both save the digits, keeping a leading "+" for an
// international number so it isn't later shown as a US number.

/** The digits of a phone number. */
export const phoneDigits = (value: string) => value.replace(/\D/g, "");

/** The phone number as saved: its digits, after a "+" when it was typed with one. */
export const savedPhone = (value: string) => (value.trim().startsWith("+") ? "+" : "") + phoneDigits(value);

/**
 * Why a typed phone number can't be saved, or "" when it can: 7–15 digits with optional formatting
 * and a leading "+". The saved number, "+" included, must fit the 15-character column.
 */
export function phoneProblem(value: string) {
  const count = phoneDigits(value).length;
  if (!/^\+?[\d\s().-]*$/.test(value.trim()) || count < 7 || count > 15)
    return "Enter a phone number with 7 to 15 digits, e.g. (410) 555-0182.";
  return savedPhone(value).length > 15 ? "That phone number is too long. After a leading +, use at most 14 digits." : "";
}
