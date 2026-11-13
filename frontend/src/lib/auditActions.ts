import type { Audit } from "./staffContracts";

/**
 * What a change log record means to a person: a readable title, the part of the shop
 * it belongs to, and whether it opened or closed something. Staff actions use the
 * application's own action names ("training.approved"); database writes use the
 * table and operation the row trigger saw ("equipment.update").
 */
export type AuditArea =
  | "access"
  | "accounts"
  | "billing"
  | "classes"
  | "equipment"
  | "memberships"
  | "notices"
  | "policies"
  | "reservations"
  | "spaces"
  | "training"
  | "other";

export const AUDIT_AREAS: { id: AuditArea; label: string }[] = [
  { id: "access", label: "Access & cards" },
  { id: "accounts", label: "Accounts & roles" },
  { id: "billing", label: "Billing & payments" },
  { id: "classes", label: "Classes" },
  { id: "equipment", label: "Equipment" },
  { id: "memberships", label: "Memberships & passes" },
  { id: "notices", label: "Notices & email" },
  { id: "policies", label: "Policies & waivers" },
  { id: "reservations", label: "Reservations" },
  { id: "spaces", label: "Studios & rooms" },
  { id: "training", label: "Training" },
  { id: "other", label: "Other" },
];

// The longest matching prefix wins, so "user.access_" is Access while "user." is Accounts.
const AREA_PREFIXES: [string, AuditArea][] = [
  ["access.", "access"],
  ["user.access_", "access"],
  ["app_access_", "access"],
  ["app_device_access_event", "access"],
  ["app_card_enrollment", "access"],
  ["app_reader_setup", "access"],
  ["check_in", "access"],
  ["visit.", "access"],
  ["app_facility_visit", "access"],
  ["user", "accounts"],
  ["account_mode.", "accounts"],
  ["minor.", "accounts"],
  ["app_minor_sponsor", "accounts"],
  ["member.", "accounts"],
  ["owner.", "accounts"],
  ["profile.", "accounts"],
  ["notifications.", "accounts"],
  ["app_notification_preferences", "accounts"],
  ["guest", "accounts"],
  ["app_pending_registration", "accounts"],
  ["app_email_confirmation", "accounts"],
  ["app_password_reset", "accounts"],
  ["billing.", "billing"],
  ["payment", "billing"],
  ["daypass.refunded", "billing"],
  ["app_membership_billing", "billing"],
  ["app_membership_invoice", "billing"],
  ["app_membership_stripe_event", "billing"],
  ["app_billing_price", "billing"],
  ["app_pass_checkout", "billing"],
  ["app_pass_stripe_event", "billing"],
  ["app_payment_security_event", "billing"],
  ["app_partner_eligibility", "billing"],
  ["app_equipment_checkout", "billing"],
  ["class.", "classes"],
  ["app_training_class", "classes"],
  ["app_training_enrollment", "classes"],
  ["app_class_catalog", "classes"],
  ["equipment", "equipment"],
  ["app_equipment_", "equipment"],
  ["membership", "memberships"],
  ["user_membership", "memberships"],
  ["daypass.", "memberships"],
  ["day_pass", "memberships"],
  ["plan.", "memberships"],
  ["service_notice.", "notices"],
  ["app_service_notice", "notices"],
  ["app_notification_", "notices"],
  ["app_brevo_delivery_event", "notices"],
  ["policy.", "policies"],
  ["waiver", "policies"],
  ["user_waiver", "policies"],
  ["reservation", "reservations"],
  ["app_minor_booking", "reservations"],
  ["app_minor_studio_booking", "reservations"],
  ["app_studio", "spaces"],
  ["studio.", "spaces"],
  ["room", "spaces"],
  ["building", "spaces"],
  ["training.", "training"],
  ["certification", "training"],
  ["user_certifications", "training"],
  ["app_training_requirement", "training"],
];

export function auditArea(action: string): AuditArea {
  let best: [string, AuditArea] | null = null;
  for (const entry of AREA_PREFIXES)
    if (action.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best?.[1] ?? "other";
}

export const areaLabel = (area: AuditArea) => AUDIT_AREAS.find((a) => a.id === area)!.label;

const TITLES: Record<string, string> = {
  "access.card_assigned": "NFC card assigned",
  "access.card_reactivated": "NFC card reactivated",
  "access.card_reassigned": "NFC card reassigned",
  "access.card_revoked": "NFC card revoked",
  "access.issued": "Access issued",
  "access.override_created": "Access override granted",
  "access.override_revoked": "Access override revoked",
  "access.reader_created": "Reader added",
  "access.reader_setup_cancelled": "Reader setup cancelled",
  "access.reader_setup_started": "Reader setup started",
  "access.reader_updated": "Reader updated",
  "account_mode.closed": "Left a member’s account",
  "account_mode.opened": "Opened a member’s account",
  "billing.assisted_checkout_requested": "Checkout link sent",
  "billing.partner.verified": "Partner discount verified",
  "billing.pricing.updated": "Pricing updated",
  "billing.refund.requested": "Refund requested",
  "certification.created": "Certification created",
  "certification.updated": "Certification updated",
  "check_in.created": "Check-in recorded",
  "class.attendance": "Class attendance recorded",
  "class.cancelled": "Class cancelled",
  "class.created": "Class scheduled",
  "class.enrolled": "Enrolled in a class",
  "class.withdrawn": "Withdrew from a class",
  "daypass.cancelled": "Day pass cancelled",
  "daypass.issued": "Day pass issued",
  "daypass.refunded": "Day pass refunded",
  "equipment.created": "Equipment added",
  "equipment.removed": "Equipment removed",
  "equipment.retired": "Equipment retired",
  "equipment.returned_to_service": "Returned to service",
  "equipment.taken_out_of_service": "Taken out of service",
  "equipment.training_configured": "Training requirement set",
  "equipment.updated": "Equipment details edited",
  "member.demo_account_created": "Demo account created",
  "membership.cancelled": "Membership cancelled",
  "membership.free.issued": "Free membership issued",
  "minor.sponsor_linked": "Sponsoring adult linked",
  "minor.sponsor_unlinked": "Sponsoring adult removed",
  "notifications.preferences_updated": "Email preferences changed",
  "owner.admin_account_created": "Administrator account created",
  "payment.paid": "Payment marked paid",
  "payment.pending": "Payment marked pending",
  "payment.recorded": "Payment recorded",
  "payment.refunded": "Payment refunded",
  "payment.void": "Payment voided",
  "payment.waived": "Payment waived",
  "plan.archived": "Plan archived",
  "plan.created": "Plan created",
  "plan.updated": "Plan updated",
  "policy.published": "Policy published",
  "policy.retired": "Policy retired",
  "profile.updated": "Profile updated",
  "reservation.cancelled": "Reservation cancelled",
  "reservation.created": "Reservation booked",
  "reservation.override.cancelled": "Override booking cancelled",
  "reservation.override.updated": "Override booking changed",
  "reservation.payment_confirmed": "Reservation payment confirmed",
  "service_notice.opened": "Service notice posted",
  "service_notice.resolved": "Service notice resolved",
  "training.approved": "Training approved",
  "training.renewed": "Training renewed",
  "training.revoked": "Training revoked",
  "user.access_active": "Access restored",
  "user.access_restored": "Access restored",
  "user.access_revoked": "Access revoked",
  "user.access_suspended": "Access suspended",
  "user.account_active": "Account reactivated",
  "user.account_inactive": "Account deactivated",
  "user.account_suspended": "Account suspended",
  "user.conduct_cleared": "Conduct flag cleared",
  "user.conduct_flagged": "Conduct flagged",
  "user.profile_updated": "Member details edited",
  "user.role_changed": "Role changed",
  "visit.check-in": "Visit checked in",
  "visit.check-out": "Visit checked out",
  "waiver.signed": "Waiver signed",
  waiver_expiry_updated: "Waiver expiry changed",
};

// Database writes are named after the table the trigger saw.
const TABLES: Record<string, string> = {
  app_access_card: "NFC card",
  app_access_override: "Access override",
  app_access_reader: "Reader",
  app_equipment_outage: "Equipment outage",
  app_equipment_retirement: "Equipment retirement",
  app_notification_outbox: "Email",
  app_service_notice: "Service notice",
  app_studio: "Studio",
  app_training_class: "Class",
  app_training_enrollment: "Class enrollment",
  building: "Building",
  certifications: "Certification",
  check_in: "Check-in",
  day_pass: "Day pass",
  equipment: "Equipment",
  membership_tiers: "Plan",
  payment: "Payment",
  reservation: "Reservation",
  room: "Room",
  user: "Account",
  user_certifications: "Member training",
  user_membership: "Membership",
  user_role: "Role",
  user_waiver: "Signed waiver",
  waiver: "Policy",
};
const OPERATIONS: Record<string, string> = { insert: "added", update: "updated", delete: "deleted" };

const humanize = (text: string) => {
  const words = text.replace(/^app_/, "").replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A readable name for an action code alone: filters and "saved with it" lists use this. */
export function actionTitle(action: string): string {
  if (TITLES[action]) return TITLES[action];
  if (action === "app_notification_outbox.insert") return "Email queued";
  const write = /^(.+)\.(insert|update|delete)$/.exec(action);
  if (write) return `${TABLES[write[1]] ?? humanize(write[1])} ${OPERATIONS[write[2]]}`;
  return humanize(action);
}

export type AuditTone = "good" | "bad" | "neutral";
const BAD = /revok|suspend|cancel|denied|taken_out|removed|retired|flagged|void|withdrawn|unlinked|inactive|\.delete$/;
const GOOD = /approved|renewed|returned_to_service|resolved|restored|reactivated|_active$|signed|published|paid|cleared|enrolled|linked|assigned|issued/;

export function describeAudit(audit: Pick<Audit, "action" | "entityType" | "allowed">) {
  if (audit.entityType === "app_device_access_event") {
    const tone: AuditTone = audit.allowed === false ? "bad" : audit.allowed === true ? "good" : "neutral";
    const title = audit.allowed === false ? "Card tap denied" : audit.allowed === true ? "Check-in allowed" : "Card scanned";
    return { title, tone, area: "access" as AuditArea };
  }
  const tone: AuditTone = BAD.test(audit.action) ? "bad" : GOOD.test(audit.action) ? "good" : "neutral";
  return { title: actionTitle(audit.action), tone, area: auditArea(audit.action) };
}

const FIELD_NAMES: Record<string, string> = {
  resolvedAt: "Resolved",
  openedAt: "Opened",
  expiresAt: "Expires",
  validUntil: "Valid until",
  startsAt: "Starts",
  endsAt: "Ends",
  ends_at: "Ends",
  starttime: "Starts",
  endtime: "Ends",
  userid: "Member",
  user_id: "Member",
  userId: "Member",
  uid_last4: "Card ending",
  tiername: "Plan name",
  tierprice: "Price",
  hourlyrate: "Hourly rate",
  statusdesc: "Status note",
  accessstatus: "Access",
  firstname: "First name",
  lastname: "Last name",
};

/** "resolvedAt" → "Resolved", "price_snapshot" → "Price snapshot". */
export function fieldLabel(field: string): string {
  if (FIELD_NAMES[field]) return FIELD_NAMES[field];
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A stored value as a person reads it. Null-ish values read as "Not set". */
export function formatFieldValue(value: unknown, timeZone: string): { text: string; empty: boolean } {
  if (value === null || value === undefined || value === "") return { text: "Not set", empty: true };
  if (typeof value === "boolean") return { text: value ? "Yes" : "No", empty: false };
  if (typeof value === "number") return { text: String(value), empty: false };
  if (typeof value === "string") {
    if (ISO_DAY.test(value))
      return {
        text: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${value}T12:00:00Z`)),
        empty: false,
      };
    // Timestamps without a zone come from "timestamp" columns the app stores in UTC.
    if (ISO_INSTANT.test(value)) {
      const at = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
      if (!Number.isNaN(at.getTime())) return { text: dateTimeIn(at, timeZone), empty: false };
    }
    return { text: value, empty: false };
  }
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object"))
    return value.length ? { text: value.join(", "), empty: false } : { text: "None", empty: true };
  const json = JSON.stringify(value);
  return { text: json.length > 240 ? json.slice(0, 239) + "…" : json, empty: false };
}

/** "Wed, Nov 11 at 6:11 PM" in the shop's time zone. */
export function dateTimeIn(at: Date | string | number, timeZone: string) {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} at ${time}`;
}
