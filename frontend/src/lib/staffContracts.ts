import type { FacilityVisit } from "./contracts";
export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}
export interface Plan {
  id: number;
  name: string;
  kind: "membership" | "day_pass";
  price: string;
  months: number | null;
  benefits: string;
  active: boolean;
  revision: number;
}
export interface Person {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: string;
  accessStatus: "active" | "suspended" | "revoked";
  accessReason: string;
  accountReason?: string;
  conductFlag: boolean;
  address: Record<string, string | boolean>;
  contactPreferences: Record<string, string | boolean>;
  roles: string[];
  primaryRole?: string;
  isStudent?: boolean;
  revision: number;
}
export interface Entitlement {
  id: number;
  userId: number;
  planId: number;
  status: string;
  effectiveStatus: string;
  revision: number;
  startsAt?: string;
  endsAt?: string;
  validDate?: string;
  plan: Partial<Plan> | null;
  reason: string;
  cancellationRequestedAt?: string | null;
  cardBilled?: boolean;
}
export interface Payment {
  id: number;
  userId: number;
  memberName: string;
  membershipId: number | null;
  dayPassId: number | null;
  amount: string;
  status: string;
  method: string;
  reference: string;
  revision: number;
  recordedAt: string;
  updatedAt: string;
  planName: string;
  /** Set for card membership payments; the Stripe invoice a refund goes through. */
  invoiceId?: string | null;
  /** Stripe refund state for that invoice, once a refund has been asked for. */
  refundStatus?: string | null;
}
export interface PaymentSummary {
  count: number;
  collected: string;
  pendingCount: number;
  pending: string;
  refunded: string;
}
export interface PaymentPage extends Page<Payment> {
  summary: PaymentSummary;
}
export interface Audit {
  id: string;
  actorId: number | null;
  actorName: string;
  subjectId: number | null;
  action: string;
  entityType: string;
  entityId: number;
  createdAt: string;
  subjectName?: string | null;
  reason?: string;
  allowed?: boolean | null;
  accessReason?: string | null;
  readerId?: string | null;
  resourceName?: string | null;
}
/** Staff actions, card taps, or database writes: see the backend's AUDIT_VIEWS. */
export type AuditView = "staff" | "taps" | "database";
export interface AuditPage extends Page<Audit> {
  /** Present when the request named a view. */
  counts?: Record<AuditView, number>;
}
export interface AuditField {
  field: string;
  before: unknown;
  after: unknown;
}
export interface AuditRecord extends Audit {
  reason: string;
  source: "application" | "database";
  /** Null when the record kept no states, as database writes never do. */
  changes: { changed: AuditField[]; unchanged: AuditField[] } | null;
  /** Other rows saved in the same transaction. */
  related: { id: string; action: string; entityType: string; entityId: number; source: "application" | "database" }[];
  relatedCount: number;
}
export interface Policy {
  id: number;
  name: string;
  version: string;
  description: string;
  effectiveAt: string;
  active: boolean;
  required: boolean;
  approvalReference: string;
  validityDays?: number | null;
  scope: 'facility' | 'equipment';
}
export interface MemberDetail {
  user: Person;
  memberships: Entitlement[];
  passes: Entitlement[];
  payments: Page<Payment>;
  audit: Page<Audit>;
  checkIns: {
    id: number;
    location: string;
    status: string;
    checkedInAt: string;
  }[];
}
export interface MembershipHistory {
  memberships: Entitlement[];
  passes: Entitlement[];
  timeZone: string;
  accessStatus: string;
}
export interface ComplianceOption {
  id: number;
  name: string;
  version?: string;
}
export interface ComplianceBreakdown {
  id: number;
  name: string;
  version?: string;
  total: number;
  compliant: number;
  expiring: number;
}
export interface ComplianceUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  accessStatus: string;
  waiverCompliant: boolean;
  certificationCompliant: boolean;
  missingWaivers: string[];
  expiringWaivers: string[];
  missingCertifications: string[];
  expiringCertifications: string[];
  /** What's wrong, item by item: never signed/trained, expired, or expiring soon. */
  issues: ComplianceIssue[];
}
export interface ComplianceIssue {
  kind: "waiver" | "certification";
  name: string;
  state: "missing" | "expired" | "expiring";
  expiresAt: string | null;
}
export interface ComplianceReport {
  summary: {
    userCount: number;
    compliantUsers: number;
    waiverCompliantUsers: number;
    certificationCompliantUsers: number;
    attentionUsers: number;
    complianceRate: number;
    waiverComplianceRate: number;
    certificationComplianceRate: number;
  };
  users: Page<ComplianceUser>;
  waiverBreakdown: ComplianceBreakdown[];
  certificationBreakdown: ComplianceBreakdown[];
  nextOffset: number | null;
  filteredCount: number;
  options: {
    waivers: ComplianceOption[];
    certifications: ComplianceOption[];
  };
}
/** GET /admin/users/:id/requirements: what gates the shop for this member now. Advisory; readers recheck. */
export interface MemberRequirements {
  account: string;
  access: Person["accessStatus"];
  entitlement:
    | { kind: "membership"; name: string; endsAt: string }
    | { kind: "day_pass"; name: string; validDate: string }
    | null;
  waivers: { required: number; signed: number; missing: string[]; lastSignedAt: string | null };
  training: { required: number; held: number; missing: string[] };
  cards: { active: number };
  minor: { sponsorName: string | null; sponsorHere: boolean } | null;
  visit: FacilityVisit | null;
}
