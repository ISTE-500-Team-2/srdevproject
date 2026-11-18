// Staff business rules wrap revision checks, record changes, audit entries and notifications in
// transactions.

import { enqueueNotification } from '../notifications/store.js';
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { transaction, type Database } from "../db.js";
import { AppError, type UserView } from "../domain.js";
import { UserModel } from "../models/UserModel.js";
import { ProfilePhotoModel } from "../models/ProfilePhotoModel.js";
import { StaffModel } from "../models/StaffModel.js";
import { billingRenewsSql } from "../models/staff/entitlements.js";
import type { IssueInput, PlanInput } from "../staffDomain.js";
import { PermissionModel } from "../models/PermissionModel.js";
import { planInput } from "../staffDomain.js";
import { retireSupersededPolicies } from "../policyLifecycle.js";
import { AccessService } from "./AccessService.js";
import { assertNoCardBillingFrom } from "../billing/openBilling.js";
import type { PolicyScope } from "../staffDomain.js";

const missing = () =>
  new AppError(404, "NOT_FOUND", "The selected record was not found.");
const conflict = () =>
  new AppError(
    409,
    "STALE_RECORD",
    "This record changed. Refresh it before making another change.",
  );
/**
 * The version in force stays current over any version dated before it, so publishing one would
 * retire it on the spot.
 */
function startsBeforeCurrent(since: Date | null | undefined, timeZone: string) {
  const when = since
    ? new Intl.DateTimeFormat("en-US", {
        timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(since)
    : null;
  return new AppError(
    409,
    "POLICY_STARTS_TOO_EARLY",
    when
      ? `The version now in force started ${when}. Choose a start at or after that time, or the new version would be retired as soon as it's published.`
      : "The version now in force started later than this. Choose a later start, or the new version would be retired as soon as it's published.",
    "effectiveAt",
  );
}
const staffAccount = () =>
  new AppError(
    403,
    "ADMIN_REQUIRED",
    "Only administrators can manage staff accounts.",
  );

/**
 * The rule target() applies, for staff routes outside this service (NFC cards, supervised use):
 * non-admin staff may not manage an account that holds the admin or staff role.
 */
export async function assertManageable(db: Database, actor: Pick<UserView, "roles">, userId: number) {
  if (actor.roles.includes("admin")) return;
  const held = await db.query(
    `SELECT 1 FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=$1 AND r.role IN ('admin','staff') LIMIT 1`,
    [userId],
  );
  if (held.rowCount) throw staffAccount();
}

export class StaffService {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}

  /**
   * Recheck the operator's current role/grants inside a serialized transaction before running a
   * staff mutation.
   */
  private async write<T>(
    actorId: number,
    adminOnly: boolean,
    resource: string,
    action: string,
    work: (model: StaffModel, actor: UserView, db: Database) => Promise<T>,
  ) {
    return transaction(this.pool, async (db) => {
      // One lock order for staff mutations avoids cross-admin deadlocks and
      // serializes role/last-admin checks. Member bookings lock only their user.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'))",
      );
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [
        actorId,
      ]);
      const actor = await new UserModel(db, this.timeZone).findById(actorId);
      const actorIsStaffOrAdmin = Boolean(
        actor &&
          Array.isArray(actor.roles) &&
          actor.roles.some((role) => role === "staff" || role === "admin"),
      );
      if (
        !actor ||
        actor.status !== "active" ||
        !actorIsStaffOrAdmin ||
        (adminOnly && !actor.roles.includes("admin"))
      )
        throw new AppError(
          403,
          "STAFF_REQUIRED",
          adminOnly
            ? "Administrator permission is required."
            : "Staff permission is required.",
        );
      if (!(await new PermissionModel(db).allows(actor, resource, action)))
        throw new AppError(403, "PERMISSION_REQUIRED", "This operation is not permitted for your role.");
      return work(new StaffModel(db, this.timeZone), actor, db);
    });
  }
  /** Lock the subject and prevent non-admin staff from managing another staff/admin account. */
  private async target(model: StaffModel, actor: UserView, id: number, lock: true | 'no-key-update' = true) {
    const user = await model.person(id, lock);
    if (!user) throw missing();
    if (
      user.roles.some((r: string) => r === "admin" || r === "staff") &&
      !actor.roles.includes("admin")
    )
      throw staffAccount();
    return user;
  }
  /** Reject stale staff edits before overwriting a record that another operator has changed. */
  private expectRevision(current: unknown, revision: number) {
    if (current !== revision) throw conflict();
  }

  createPlan(actorId: number, input: PlanInput, reason: string) {
    return this.write(actorId, false, "plan", "create", async (model) => {
      const record = await model.createPlan(input);
      await model.audit(
        actorId,
        null,
        "plan.created",
        "plan",
        record.id,
        reason,
        null,
        record,
      );
      return record;
    });
  }
  updatePlan(
    actorId: number,
    id: number,
    input: PlanInput,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, "plan", "update", async (model) => {
      const before = await model.plan(id);
      if (!before) throw missing();
      this.expectRevision(before.revision, revision);
      if (before.kind !== input.kind)
        throw new AppError(
          409,
          "PLAN_KIND_IMMUTABLE",
          "Create a separate plan to change its kind.",
        );
      const after = await model.updatePlan(id, input, revision);
      if (!after) throw conflict();
      await model.audit(
        actorId,
        null,
        after.active ? "plan.updated" : "plan.archived",
        "plan",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
  profile(
    actorId: number,
    id: number,
    firstName: string,
    lastName: string,
    phone: string,
    revision: number,
    reason: string,
    dob: string | null = null,
  ) {
    return this.write(actorId, false, "user", "update", async (model, actor) => {
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      // Staff add a date of birth that was never recorded. Changing one would change who
      // counts as a minor under existing sponsor links, so that isn't done here.
      if (dob && before.dobOnFile)
        throw new AppError(409, "DOB_ON_FILE", "A date of birth is already on file for this account.");
      const after = await model.updatePerson(
        id,
        firstName,
        lastName,
        phone,
        revision,
        dob,
      );
      if (!after) throw conflict();
      await model.audit(
        actorId,
        id,
        "user.profile_updated",
        "user",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
  accountStatus(actorId: number, id: number, status: string, revision: number, reason: string) {
    return this.write(actorId, false, "user_access", "update", async (model, actor, db) => {
      if (actorId === id)
        throw new AppError(409, "SELF_CHANGE_FORBIDDEN", "Another administrator must change your account status.");
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      if (status !== "active" && before.status === "active" && before.roles.includes("admin") && await model.activeAdmins() <= 1)
        throw new AppError(409, "LAST_ADMIN", "The final active administrator cannot be suspended or blocked.");
      const after = await model.accountStatus(id, status, reason, revision);
      if (!after) throw conflict();
      // Session issuance holds this user's share lock before creating/rotating a
      // family. The target update lock makes revocation atomic with the status.
      // Restoration also ends families left live by legacy status changes.
      if (status !== "active" || before.status !== "active")
        await db.query('UPDATE app_refresh_family SET revoked=true WHERE userid=$1', [id]);
      await model.audit(actorId, id, "user.account_" + status, "user", id, reason, before, after);
      return after;
    });
  }
  /** A staff-only marker. It never blocks access by itself; facility access does that. */
  conduct(actorId: number, id: number, flagged: boolean, revision: number, reason: string) {
    return this.write(actorId, false, "user_access", "update", async (model, actor) => {
      if (actorId === id)
        throw new AppError(409, "SELF_CHANGE_FORBIDDEN", "Another administrator must change your conduct flag.");
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      const after = await model.conduct(id, flagged, revision);
      if (!after) throw conflict();
      await model.audit(actorId, id, flagged ? "user.conduct_flagged" : "user.conduct_cleared", "user", id, reason, before, after);
      return after;
    });
  }
  access(
    actorId: number,
    id: number,
    status: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, "user_access", "update", async (model, actor) => {
      if (actorId === id)
        throw new AppError(
          409,
          "SELF_CHANGE_FORBIDDEN",
          "Another administrator must change your facility access.",
        );
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      const after = await model.access(id, status, reason, revision);
      if (!after) throw conflict();
      await model.audit(
        actorId,
        id,
        "user.access_" + status,
        "user",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
  /**
   * Remove a member's profile photo, for example one that isn't a photo of them. `version` is the
   * photo staff were looking at: a member who has since changed it gets a conflict, not a removal.
   */
  removePhoto(actorId: number, id: number, version: string, reason: string) {
    return this.write(actorId, false, "user", "update", async (model, actor, db) => {
      // The account lock (FOR NO KEY UPDATE) is the one member photo changes take.
      await this.target(model, actor, id, "no-key-update");
      const photos = new ProfilePhotoModel(db);
      const current = await photos.version(id);
      if (!current) return { version: null };
      if (current !== version)
        throw new AppError(409, "STALE_RECORD", "This member changed their photo just now. Look at the new one first.");
      await photos.remove(id);
      await model.audit(actorId, id, "user.photo_removed", "user", id, reason, { photoVersion: current }, { photoVersion: null });
      // Staff reasons are private, as for account and access changes: the email says only what happened.
      await enqueueNotification(db, { userId: id, kind: "photo_removed", dedupeKey: `photo-removed:${id}:${current}`, payload: {} });
      return { version: null };
    });
  }
  /** Protect the last active administrator while updating role assignments and audit evidence. */
  role(
    actorId: number,
    id: number,
    role: string,
    revision: number,
    reason: string,
    roles?: string[],
    isStudent?: boolean,
  ) {
    return this.write(actorId, true, "user_role", "update", async (model, actor) => {
      if (actorId === id)
        throw new AppError(
          409,
          "SELF_CHANGE_FORBIDDEN",
          "Another administrator must change your role.",
        );
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      const assigned = roles ?? [...new Set([...before.roles.filter((r: string) => r !== before.primaryRole),role])];
      if (!(await model.roleExists(role)))
        throw new AppError(
          409,
          "ROLE_NOT_CONFIGURED",
          "That role must first be configured in the database.",
        );
      // Only an active administrator counts toward the last one, as for account status.
      if (
        before.status === "active" &&
        before.roles.includes("admin") &&
        !assigned.includes("admin") &&
        (await model.activeAdmins()) <= 1
      )
        throw new AppError(
          409,
          "LAST_ADMIN",
          "The final active administrator cannot be removed.",
        );
      const after = await model.setRole(id, role, assigned, isStudent);
      await model.audit(
        actorId,
        id,
        "user.role_changed",
        "user",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
  /**
   * Issue an entitlement and its payment/audit evidence together so access cannot be partially
   * granted after a failed save.
   */
  issue(actorId: number, userId: number, input: IssueInput) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ userId, ...input }))
      .digest("hex");
    return this.write(actorId, false, "entitlement", "create", async (model, actor, db) => {
      // Same lock as online checkout/issuance, taken before target/plan locks.
      await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userId]);
      const user = await this.target(model, actor, userId);
      const previous = await model.request(input.requestId);
      if (previous) {
        if (
          previous.actorId !== actorId ||
          previous.fingerprint !== fingerprint
        )
          throw new AppError(
            409,
            "REQUEST_ID_REUSED",
            "This issuance request ID was already used for different details.",
          );
        return { ...previous.result, replayed: true };
      }
      if (user.status !== "active")
        throw new AppError(
          409,
          "ACCOUNT_INACTIVE",
          "Activate the user account before issuing access.",
        );
      const plan = await model.plan(input.planId, true);
      if (!plan || !plan.active)
        throw new AppError(409, "PLAN_UNAVAILABLE", "Choose an active plan.");
      // Legacy catalog rows were not created through this API's validation.
      planInput({ ...plan });
      let id: number;
      if (plan.kind === "membership") {
        if (!input.startsAt || input.validDate || !plan.months)
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Membership issuance requires a start time only and a valid monthly plan.",
          );
        const window = await model.membershipWindow(
          userId,
          input.startsAt,
          plan.months,
        );
        if (window.endsAt <= new Date())
          throw new AppError(
            400,
            "EXPIRED_WINDOW",
            "The membership must end in the future.",
          );
        if (window.overlap)
          throw new AppError(
            409,
            "MEMBERSHIP_OVERLAP",
            "An active or suspended membership already covers part of that period. For renewal, start at the existing end time.",
          );
        // A card subscription or checkout would charge again for these dates.
        await assertNoCardBillingFrom(db, userId, input.startsAt);
        id = await model.createMembership(
          userId,
          plan,
          input.startsAt,
          window.endsAt,
          actorId,
          input.reason,
        );
      } else {
        if (!input.validDate || input.startsAt)
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Day-pass issuance requires a valid date only.",
          );
        const today = (
          await db.query(
            "SELECT to_char(NOW() AT TIME ZONE $1,'YYYY-MM-DD') AS today",
            [this.timeZone],
          )
        ).rows[0]!.today;
        if (input.validDate < today)
          throw new AppError(
            400,
            "EXPIRED_WINDOW",
            "Choose today or a future date for the pass.",
          );
        if (await model.passExists(userId, input.validDate))
          throw new AppError(
            409,
            "PASS_EXISTS",
            "An active or suspended pass already exists for that date.",
          );
        await new AccessService(db, this.timeZone).assertWaivers(userId);
        id = await model.createPass(
          userId,
          plan,
          input.validDate,
          actorId,
          input.reason,
        );
      }
      const paymentId = await model.createPayment(
        userId,
        plan.kind === "membership" ? id : null,
        input.paymentStatus === "waived" ? "0.00" : plan.price,
        input.paymentStatus,
        input.method,
        input.reference,
        input.reason,
        actorId,
      );
      if (plan.kind === "day_pass") await model.linkPassPayment(id, paymentId);
      const result = {
        kind: plan.kind,
        id,
        userId,
        paymentId,
        plan,
        replayed: false,
      };
      await model.audit(
        actorId,
        userId,
        "access.issued",
        plan.kind,
        id,
        input.reason,
        null,
        result,
      );
      await model.audit(
        actorId,
        userId,
        "payment.recorded",
        "payment",
        paymentId,
        input.reason,
        null,
        await model.payment(paymentId),
      );
      await model.saveRequest(input.requestId, actorId, fingerprint, result);
      await enqueueNotification(db,{userId,kind:plan.kind === 'membership' ? 'membership_issued' : 'day_pass_issued',dedupeKey:`entitlement-issued:${plan.kind}:${id}`,payload:{membershipName:plan.name,startsAt:input.startsAt ?? input.validDate}});
      await enqueueNotification(db,{userId,kind:input.paymentStatus === 'paid' ? 'payment_recorded' : 'payment_status_changed',dedupeKey:`payment-recorded:${paymentId}`,payload:{paymentId,amount:input.paymentStatus === 'waived' ? '0.00' : plan.price,currency:'USD',method:input.method,reference:input.reference,paymentStatus:input.paymentStatus} });
      return result;
    });
  }
  entitlementStatus(
    actorId: number,
    userId: number,
    kind: "membership" | "day_pass",
    id: number,
    status: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, "entitlement", "update", async (model, actor, db) => {
      const member = await this.target(model, actor, userId);
      const before = await model.entitlement(kind, id);
      if (!before || before.userId !== userId) throw missing();
      this.expectRevision(before.revision, revision);
      if (before.status === "revoked" && status !== "revoked")
        throw new AppError(
          409,
          "REVOKED_ENTITLEMENT",
          "Issue a new entitlement instead of restoring a revoked one.",
        );
      // A pass the member cancelled (and may have been refunded for) stays closed.
      if (!["active", "suspended", "revoked"].includes(before.status))
        throw new AppError(
          409,
          "ENTITLEMENT_CLOSED",
          `This ${kind === "membership" ? "membership" : "day pass"} is ${before.status || "closed"}. Issue a new one instead of changing it.`,
        );
      // Ending access doesn't stop card billing, and each paid renewal would charge for a period
      // that stays ended. Renewal has to be turned off first, which staff do from the member's
      // record (MembershipBilling.stopRenewal) even while the account is on hold or restricted.
      if (
        kind === "membership" &&
        status === "revoked" &&
        (
          await db.query(
            `SELECT 1 FROM app_membership_invoice i JOIN app_membership_billing b ON b.id=i.billing_id
            WHERE i.membership_id=$1 AND ${billingRenewsSql} LIMIT 1`,
            [id],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          "CARD_RENEWAL_ACTIVE",
          `This membership still renews by card. Choose Stop auto-renew on ${member.firstName}’s membership first, so they aren’t charged again, then end access.`,
        );
      const after = await model.changeEntitlement(
        kind,
        id,
        status,
        reason,
        revision,
      );
      if (!after) throw conflict();
      await model.audit(
        actorId,
        userId,
        "entitlement." + status,
        kind,
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
  /**
   * Apply allowed payment-state changes with revision checks; provider-managed payments require
   * their dedicated flow.
   */
  paymentStatus(
    actorId: number,
    id: number,
    status: string,
    method: string,
    reference: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, "payment", "update", async (model, actor, db) => {
      // Bookings and training lock the member before the payment. Read ownership
      // without a payment lock, then recheck it after acquiring locks in that order.
      const owner = (await db.query('SELECT userid FROM payment WHERE paymentid=$1', [id])).rows[0];
      if (owner?.userid == null) throw missing();
      // Cancellation audit rows take KEY SHARE on the member while holding the
      // payment. NO KEY UPDATE still blocks member edits and booking locks, but
      // lets those foreign-key checks finish without a user/payment deadlock.
      await this.target(model, actor, owner.userid, 'no-key-update');
      const before = await model.payment(id);
      if (!before || before.userId == null) throw missing();
      if (before.userId !== owner.userid) throw conflict();
      if ((await db.query('SELECT id::text FROM app_membership_invoice WHERE payment_id=$1 UNION ALL SELECT id::text FROM app_pass_checkout WHERE payment_id=$1 AND amount_cents>0 UNION ALL SELECT reservation_id::text FROM app_equipment_checkout WHERE payment_id=$1',[id])).rowCount)
        throw new AppError(409,'PROVIDER_PAYMENT','Use the Stripe billing refund workflow for this payment.');
      // While a booking's card checkout is open, its payment is linked only from the reservation.
      // Recording it at the desk would leave the checkout able to charge again, or let the unpaid
      // hold cancel a booking the member paid for.
      if ((await db.query("SELECT 1 FROM reservation r JOIN app_equipment_checkout c ON c.reservation_id=r.reservationid WHERE r.payment_id=$1 AND c.status='pending'",[id])).rowCount)
        throw new AppError(409,'PROVIDER_PAYMENT','This booking is paid by card online. The member pays through its checkout; if they won’t, cancel the reservation instead.');
      this.expectRevision(before.revision, revision);
      const transitions: Record<string, string[]> = {
        pending: ["paid", "void", "waived"],
        paid: ["refunded"],
        waived: [],
        void: [],
        refunded: [],
      };
      if (!(transitions[before.status] ?? []).includes(status))
        throw new AppError(
          409,
          "INVALID_PAYMENT_TRANSITION",
          "This payment record cannot move to that status.",
        );
      if(status==='refunded'&&method!==before.method)throw new AppError(400,'ORIGINAL_METHOD_REQUIRED','Record the refund against the original payment method.');
      const after = await model.updatePayment(
        id,
        status,
        method,
        reference,
        reason,
        revision,
      );
      if (!after) throw conflict();
      await model.audit(
        actorId,
        before.userId,
        "payment." + status,
        "payment",
        id,
        reason,
        before,
        after,
      );
      await enqueueNotification(db,{userId:before.userId,kind:status === 'refunded' ? 'payment_refunded' : status === 'paid' ? 'payment_recorded' : 'payment_status_changed',dedupeKey:`payment-status:${id}:${after.revision}`,payload:{paymentId:id,amount:after.amount,currency:'USD',method,reference,paymentStatus:status}});
      return after;
    });
  }
  /**
   * Publish a new policy version with approval/effective-date validation rather than rewriting
   * already signed text.
   */
  publishPolicy(
    actorId: number,
    input: {
      name: string;
      version: string;
      description: string;
      effectiveAt: string;
      approvalReference: string;
      validityDays: number;
      reason: string;
      scope?: PolicyScope;
    },
  ) {
    return this.write(actorId, true, "waiver", "create", async (model, _actor, db) => {
      const versions = (await model.policies()).filter(policy => policy.name === input.name);
      // Omitted scope on older clients must not turn an equipment waiver's
      // replacement into a facility-wide prerequisite.
      const previous = versions[0];
      // Checked up front so the admin hears when the version in force started.
      const inForce = versions.find(policy => policy.active && (policy.effectiveAt === null || policy.effectiveAt.getTime() <= Date.now()));
      if (inForce?.effectiveAt && Date.parse(input.effectiveAt) < inForce.effectiveAt.getTime())
        throw startsBeforeCurrent(inForce.effectiveAt, this.timeZone);
      const after = await model.createPolicy(
        input.name,
        input.version,
        input.description,
        input.effectiveAt,
        input.approvalReference,
        actorId,
        input.validityDays,
        input.scope ?? previous?.scope ?? 'facility',
      );
      await model.audit(
        actorId,
        null,
        "policy.published",
        "waiver",
        after.id,
        input.reason,
        null,
        after,
      );
      // Reuse this transaction and its staff-write lock. Calling retirePolicy()
      // here would open another transaction competing for the very same lock.
      const retired = await retireSupersededPolicies(db, {
        name: input.name,
        actorId,
        reason: input.reason,
      });
      // Never report success for a version that is already retired; roll it back instead.
      if (retired.includes(after.id)) throw startsBeforeCurrent(inForce?.effectiveAt, this.timeZone);
      return after;
    });
  }
  retirePolicy(actorId: number, id: number, reason: string) {
    return this.write(actorId, true, "waiver", "update", async (model, _actor, db) => {
      const before = (await model.policies()).find((p) => p.id === id);
      if (!before) throw missing();
      // A scheduled replacement may have just become current before the worker's
      // next scan. Retire its predecessors first so withdrawing it cannot revive
      // an obsolete agreement. This remains in the same locked transaction.
      const retired = await retireSupersededPolicies(db, {
        name: before.name,
        actorId,
        reason,
      });
      if (!before.active || retired.includes(id)) return { ...before, active: false };
      await db.query("UPDATE waiver SET isactive=false WHERE waiverid=$1", [
        id,
      ]);
      const after = { ...before, active: false };
      await model.audit(
        actorId,
        null,
        "policy.retired",
        "waiver",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
  }
}
