// Phone numbers as the contact form saves them and as the page shows them.

import { phoneDigits as digits, savedPhone } from "../../lib/phone";
import { FormMessage } from "../profileSections";

/**
 * The phone number as stored: its digits, keeping a leading "+" for an international number.
 * Anything else (letters, an extension, too few or too many digits) is refused with a message
 * rather than having characters silently dropped. The column holds 15 characters.
 */
export function phoneToSave(value: string) {
  const entered = value.trim();
  const saved = savedPhone(entered);
  if (!/^\+?[\d\s().-]+$/.test(entered))
    throw new FormMessage("Enter just the number: digits, spaces, dashes or brackets, and a leading + if it’s international. Extensions can’t be saved.");
  if (digits(entered).length < 7) throw new FormMessage("That phone number is too short. Include the area code.");
  if (saved.length > 15) throw new FormMessage("That phone number is too long.");
  return saved;
}
/**
 * (410) 555-0182 for US numbers: ten digits, or eleven starting with 1 (with or without a "+").
 * Anything else, including a ten-digit number with a "+" country code such as +49 30 123456,
 * is shown as entered, so the edit form saves it back with its "+".
 */
export function formatPhone(value: string) {
  const d = digits(value);
  const international = value.trim().startsWith("+");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 && !international ? d : "";
  return ten ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value;
}
