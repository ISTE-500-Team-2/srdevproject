/**
 * How a check-in was recorded; stored in check_in.origin (migration 040). "portal" is any
 * check-in recorded in the web app rather than at a reader. Members can only check themselves
 * in at a reader, so new ones are staff at the front desk (the desk check-in, or Check in from
 * an account opened with View as); older ones may be a member's own web check-in.
 */
export type CheckInOrigin = "nfc" | "portal";

/**
 * SQL expression for a check-in's origin, where `table` is the check_in table
 * name or alias in the surrounding query (a fixed identifier, never user input).
 * Rows without an origin (written before migration 040, or by the previous
 * release during a blue-green switch) fall back to the old status-text rule.
 */
export function checkInOriginSql(table: string): string {
  return `COALESCE(${table}.origin,CASE WHEN ${table}.statusdesc ILIKE '%NFC%' THEN 'nfc' ELSE 'portal' END)`;
}
