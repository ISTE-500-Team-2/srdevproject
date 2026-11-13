import type { Database } from "../db.js";
import type { PlanInput, PolicyScope } from "../staffDomain.js";
import { AuditRepository, type AuditFilters } from "./staff/audits.js";
import { ComplianceReports, type ComplianceFilters } from "./staff/compliance.js";
import { EntitlementRepository, type EntitlementKind } from "./staff/entitlements.js";
import { IssuanceRequestRepository } from "./staff/issuanceRequests.js";
import { PaymentRepository, type PaymentFilters } from "./staff/payments.js";
import { PeopleRepository } from "./staff/people.js";
import { PlanRepository, type Plan } from "./staff/plans.js";
import { PolicyRepository } from "./staff/policies.js";

export type { Plan } from "./staff/plans.js";
export type { StaffPerson } from "./staff/people.js";
export type {
  DayPassRecord,
  EntitlementKind,
  EntitlementState,
  MembershipRecord,
  MembershipWindow,
  PlanSnapshot,
} from "./staff/entitlements.js";
export type { PaymentFilters, PaymentListItem, PaymentRecord, PaymentSummary } from "./staff/payments.js";
export type { AuditEntry, AuditFilters } from "./staff/audits.js";
export type { IssuanceRequest } from "./staff/issuanceRequests.js";
export type { PolicyRecord } from "./staff/policies.js";
export {
  COMPLIANCE_EXPORT_LIMIT,
  type ComplianceFilters,
  type ComplianceOptions,
  type ComplianceReport,
  type ComplianceUser,
} from "./staff/compliance.js";

/**
 * Facade over the staff repositories in ./staff. Each method only delegates, so
 * existing callers (and tests that patch these prototype methods) keep working.
 */
export class StaffModel {
  private readonly planRecords: PlanRepository;
  private readonly people: PeopleRepository;
  private readonly entitlements: EntitlementRepository;
  private readonly paymentRecords: PaymentRepository;
  private readonly auditTrail: AuditRepository;
  private readonly issuanceRequests: IssuanceRequestRepository;
  private readonly policyRecords: PolicyRepository;
  private readonly complianceReports: ComplianceReports;
  constructor(db: Database, timeZone = "America/New_York") {
    this.planRecords = new PlanRepository(db);
    this.people = new PeopleRepository(db);
    this.entitlements = new EntitlementRepository(db, timeZone);
    this.paymentRecords = new PaymentRepository(db);
    this.auditTrail = new AuditRepository(db);
    this.issuanceRequests = new IssuanceRequestRepository(db);
    this.policyRecords = new PolicyRepository(db);
    this.complianceReports = new ComplianceReports(db);
  }

  plans(activeOnly?: boolean) {
    return this.planRecords.plans(activeOnly);
  }
  plan(id: number, lock?: boolean) {
    return this.planRecords.plan(id, lock);
  }
  createPlan(input: PlanInput) {
    return this.planRecords.createPlan(input);
  }
  updatePlan(id: number, input: PlanInput, revision: number) {
    return this.planRecords.updatePlan(id, input, revision);
  }

  users(search: string, offset: number) {
    return this.people.users(search, offset);
  }
  person(id: number, lock?: boolean | 'no-key-update') {
    return this.people.person(id, lock);
  }
  updatePerson(id: number, firstName: string, lastName: string, phone: string, revision: number) {
    return this.people.updatePerson(id, firstName, lastName, phone, revision);
  }
  access(id: number, status: string, reason: string, revision: number) {
    return this.people.access(id, status, reason, revision);
  }
  conduct(id: number, flagged: boolean, revision: number) {
    return this.people.conduct(id, flagged, revision);
  }
  accountStatus(id: number, status: string, reason: string, revision: number) {
    return this.people.accountStatus(id, status, reason, revision);
  }
  setRole(id: number, role: string, roles?: string[], isStudent?: boolean) {
    return this.people.setRole(id, role, roles, isStudent);
  }
  roleExists(role: string) {
    return this.people.roleExists(role);
  }
  activeAdmins() {
    return this.people.activeAdmins();
  }

  memberships(userId: number) {
    return this.entitlements.memberships(userId);
  }
  passes(userId: number) {
    return this.entitlements.passes(userId);
  }
  entitlement(kind: EntitlementKind, id: number) {
    return this.entitlements.entitlement(kind, id);
  }
  membershipWindow(userId: number, startsAt: string, months: number) {
    return this.entitlements.membershipWindow(userId, startsAt, months);
  }
  passExists(userId: number, date: string) {
    return this.entitlements.passExists(userId, date);
  }
  createMembership(userId: number, plan: Plan, startsAt: string, endsAt: Date, actorId: number, reason: string) {
    return this.entitlements.createMembership(userId, plan, startsAt, endsAt, actorId, reason);
  }
  createPass(userId: number, plan: Plan, date: string, actorId: number, reason: string) {
    return this.entitlements.createPass(userId, plan, date, actorId, reason);
  }
  changeEntitlement(kind: EntitlementKind, id: number, status: string, reason: string, revision: number) {
    return this.entitlements.changeEntitlement(kind, id, status, reason, revision);
  }

  createPayment(
    userId: number,
    membershipId: number | null,
    price: string,
    status: string,
    method: string,
    reference: string,
    reason: string,
    actorId: number,
  ) {
    return this.paymentRecords.createPayment(userId, membershipId, price, status, method, reference, reason, actorId);
  }
  linkPassPayment(passId: number, paymentId: number) {
    return this.paymentRecords.linkPassPayment(passId, paymentId);
  }
  payment(id: number) {
    return this.paymentRecords.payment(id);
  }
  updatePayment(id: number, status: string, method: string, reference: string, reason: string, revision: number) {
    return this.paymentRecords.updatePayment(id, status, method, reference, reason, revision);
  }
  payments(userId: number | null, offset?: number, filters?: PaymentFilters) {
    return this.paymentRecords.payments(userId, offset, filters);
  }
  /** Totals for every payment matching the filters, not just the current page. */
  paymentSummary(userId: number | null, filters?: PaymentFilters) {
    return this.paymentRecords.paymentSummary(userId, filters);
  }

  audit(
    actor: number | null,
    subject: number | null,
    action: string,
    type: string,
    id: number,
    reason: string,
    before: unknown,
    after: unknown,
  ) {
    return this.auditTrail.audit(actor, subject, action, type, id, reason, before, after);
  }
  auditActions() {
    return this.auditTrail.auditActions();
  }
  audits(filters: AuditFilters, offset?: number) {
    return this.auditTrail.audits(filters, offset);
  }

  request(id: string) {
    return this.issuanceRequests.request(id);
  }
  saveRequest(id: string, actorId: number, fingerprint: string, result: unknown) {
    return this.issuanceRequests.saveRequest(id, actorId, fingerprint, result);
  }

  policies() {
    return this.policyRecords.policies();
  }
  createPolicy(
    name: string,
    version: string,
    description: string,
    effectiveAt: string,
    approvalReference: string,
    actorId: number,
    validityDays?: number,
    scope?: PolicyScope,
  ) {
    return this.policyRecords.createPolicy(name, version, description, effectiveAt, approvalReference, actorId, validityDays, scope);
  }

  complianceOptions() {
    return this.complianceReports.complianceOptions();
  }
  compliance(filters: ComplianceFilters, includeAllRows?: boolean) {
    return this.complianceReports.compliance(filters, includeAllRows);
  }
}
