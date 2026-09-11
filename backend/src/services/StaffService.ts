import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { transaction, type Database } from "../db.js";
import { AppError, type UserView } from "../domain.js";
import { UserModel } from "../models/UserModel.js";
import { StaffModel } from "../models/StaffModel.js";
import type { IssueInput, PlanInput } from "../staffDomain.js";
import { planInput } from "../staffDomain.js";

const missing = () =>
  new AppError(404, "NOT_FOUND", "The selected record was not found.");
const conflict = () =>
  new AppError(
    409,
    "STALE_RECORD",
    "This record changed. Refresh it before making another change.",
  );

export class StaffService {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}

  private async write<T>(
    actorId: number,
    adminOnly: boolean,
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
      const actor = await new UserModel(db).findById(actorId);
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
      return work(new StaffModel(db, this.timeZone), actor, db);
    });
  }
  private async target(model: StaffModel, actor: UserView, id: number) {
    const user = await model.person(id, true);
    if (!user) throw missing();
    if (
      user.roles.some((r: string) => r === "admin" || r === "staff") &&
      !actor.roles.includes("admin")
    )
      throw new AppError(
        403,
        "ADMIN_REQUIRED",
        "Only administrators can manage staff accounts.",
      );
    return user;
  }
  private expectRevision(current: unknown, revision: number) {
    if (current !== revision) throw conflict();
  }

  createPlan(actorId: number, input: PlanInput, reason: string) {
    return this.write(actorId, false, async (model) => {
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
    return this.write(actorId, false, async (model) => {
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
  ) {
    return this.write(actorId, false, async (model, actor) => {
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      const after = await model.updatePerson(
        id,
        firstName,
        lastName,
        phone,
        revision,
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
  access(
    actorId: number,
    id: number,
    status: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, async (model, actor) => {
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
  role(
    actorId: number,
    id: number,
    role: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, true, async (model, actor) => {
      if (actorId === id)
        throw new AppError(
          409,
          "SELF_CHANGE_FORBIDDEN",
          "Another administrator must change your role.",
        );
      const before = await this.target(model, actor, id);
      this.expectRevision(before.revision, revision);
      if (!(await model.roleExists(role)))
        throw new AppError(
          409,
          "ROLE_NOT_CONFIGURED",
          "That role must first be configured in the database.",
        );
      if (
        before.roles.includes("admin") &&
        role !== "admin" &&
        (await model.activeAdmins()) <= 1
      )
        throw new AppError(
          409,
          "LAST_ADMIN",
          "The final active administrator cannot be removed.",
        );
      const after = await model.setRole(id, role);
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
  issue(actorId: number, userId: number, input: IssueInput) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ userId, ...input }))
      .digest("hex");
    return this.write(actorId, false, async (model, actor, db) => {
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
    return this.write(actorId, false, async (model, actor) => {
      await this.target(model, actor, userId);
      const before = await model.entitlement(kind, id);
      if (!before || before.userId !== userId) throw missing();
      this.expectRevision(before.revision, revision);
      if (before.status === "revoked" && status !== "revoked")
        throw new AppError(
          409,
          "REVOKED_ENTITLEMENT",
          "Issue a new entitlement instead of restoring a revoked one.",
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
  paymentStatus(
    actorId: number,
    id: number,
    status: string,
    method: string,
    reference: string,
    revision: number,
    reason: string,
  ) {
    return this.write(actorId, false, async (model, actor) => {
      const before = await model.payment(id);
      if (!before || before.userId == null) throw missing();
      await this.target(model, actor, before.userId);
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
      return after;
    });
  }
  publishPolicy(
    actorId: number,
    input: {
      name: string;
      version: string;
      description: string;
      effectiveAt: string;
      approvalReference: string;
      reason: string;
    },
  ) {
    return this.write(actorId, true, async (model) => {
      const after = await model.createPolicy(
        input.name,
        input.version,
        input.description,
        input.effectiveAt,
        input.approvalReference,
        actorId,
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
      return after;
    });
  }
  retirePolicy(actorId: number, id: number, reason: string) {
    return this.write(actorId, true, async (model, _actor, db) => {
      const before = (await model.policies()).find((p) => p.id === id);
      if (!before) throw missing();
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
