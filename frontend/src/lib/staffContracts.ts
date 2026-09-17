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
  roles: string[];
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
}
export interface Audit {
  id: string;
  actorId: number;
  actorName: string;
  subjectId: number | null;
  action: string;
  entityType: string;
  entityId: number;
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
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
