// Phone numbers as members type them. Formatting is welcome while typing; only the digits are saved,
// so sign-up and the profile's Contact form store the same number the same way.

/** The digits of a phone number, which is what gets saved. */
export const phoneDigits = (value: string) => value.replace(/\D/g, "");

/** Why a typed phone number can't be saved, or "" when it can: 7–15 digits, with optional formatting. */
export function phoneProblem(value: string) {
  const count = phoneDigits(value).length;
  return /^[\d\s().+-]*$/.test(value) && count >= 7 && count <= 15
    ? ""
    : "Enter a phone number with 7 to 15 digits, e.g. (410) 555-0182.";
}
