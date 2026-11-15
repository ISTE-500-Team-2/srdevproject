// CSV and PDF exports list the same sections in the same order.
// Row sections hold arrays of records; summary sections hold one record each.
export const EXPORT_ROW_SECTIONS = [
  "revenue",
  "equipment",
  "patterns",
  "classes",
  "rooms",
  "live",
  "usage",
  "memberships",
] as const;
export const EXPORT_SUMMARY_SECTIONS = ["active", "compliance"] as const;
