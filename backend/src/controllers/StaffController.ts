import type { Request, Response } from "express";
import type { Pool } from "pg";
import { AppError, positiveId, textField } from "../domain.js";
import { authState } from "../middleware/auth.js";
import { COMPLIANCE_EXPORT_LIMIT, StaffModel } from "../models/StaffModel.js";
import { StaffService } from "../services/StaffService.js";
import {
  instant,
  issueInput,
  oneOf,
  pageOffset,
  paymentMethod,
  planInput,
  reasonField,
  revisionField,
  validatePaymentMethod,
} from "../staffDomain.js";

export function page<T>(rows: T[], offset: number) {
  return {
    items: rows.slice(0, 50),
    nextOffset: rows.length > 50 ? offset + 50 : null,
  };
}
function optionalPositiveId(value: unknown, name: string) {
  if (value == null || value === "") return null;
  return positiveId(value, name);
}
function optionalDays(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value) || Number(value) > 3650)
    throw new AppError(400, "INVALID_INPUT", "Expiration window must be 0 to 3650 days.");
  return Number(value);
}
function optionalAuditAction(value: unknown) {
  if (value == null || value === "") return null;
  const action = textField(value, "Audit action", 100);
  if (!/^[a-z][a-z0-9_.-]*$/.test(action))
    throw new AppError(400, "INVALID_INPUT", "Audit action is invalid.");
  return action;
}
function optionalInstant(value: unknown) {
  if (value == null || value === "") return null;
  return instant(value);
}
function csvCell(value: unknown) {
  const text = Array.isArray(value)
    ? value.join("; ")
    : value == null
      ? ""
      : String(value);
  const safe = /^[\s]*[=+\-@]/.test(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export class StaffController {
  private model: StaffModel;
  private service: StaffService;
  constructor(
    private pool: Pool,
    timeZone: string,
  ) {
    this.model = new StaffModel(pool, timeZone);
    this.service = new StaffService(pool, timeZone);
  }
  plans = async (_req: Request, res: Response) => {
    res.json({ data: await this.model.plans() });
  };
  createPlan = async (req: Request, res: Response) => {
    res.status(201).json({
      data: await this.service.createPlan(
        authState(res).user.id,
        planInput(req.body),
        reasonField(req.body.reason),
      ),
    });
  };
  updatePlan = async (req: Request, res: Response) => {
    res.json({
      data: await this.service.updatePlan(
        authState(res).user.id,
        positiveId(req.params.id),
        planInput(req.body),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
      ),
    });
  };
  users = async (req: Request, res: Response) => {
    const offset = pageOffset(req.query.offset);
    res.json({
      data: page(
        await this.model.users(
          textField(req.query.search ?? "", "Search", 100, 0),
          offset,
        ),
        offset,
      ),
    });
  };
  user = async (req: Request, res: Response) => {
    const id = positiveId(req.params.id);
    const user = await this.model.person(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "User not found.");
    const [memberships, passes, payments, audit, checkIns] = await Promise.all([
      this.model.memberships(id),
      this.model.passes(id),
      this.model.payments(id),
      this.model.audits({ subjectId: id }),
      this.pool.query(
        `SELECT checkinid AS id,location,status,checkintime AT TIME ZONE 'UTC' AS "checkedInAt" FROM check_in WHERE userid=$1 ORDER BY checkintime DESC LIMIT 50`,
        [id],
      ),
    ]);
    res.json({
      data: {
        user,
        memberships,
        passes,
        payments: page(payments, 0),
        audit: page(audit, 0),
        checkIns: checkIns.rows,
      },
    });
  };
  profile = async (req: Request, res: Response) => {
    res.json({
      data: await this.service.profile(
        authState(res).user.id,
        positiveId(req.params.id),
        textField(req.body.firstName, "First name", 50),
        textField(req.body.lastName, "Last name", 50),
        textField(req.body.phone, "Phone", 15),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
      ),
    });
  };
  accountStatus = async (req: Request, res: Response) => {
    res.json({ data: await this.service.accountStatus(
      authState(res).user.id,
      positiveId(req.params.id),
      oneOf(req.body.status, ["active", "suspended", "inactive"] as const, "Account status"),
      revisionField(req.body.revision),
      reasonField(req.body.reason),
    ) });
  };
  access = async (req: Request, res: Response) => {
    res.json({
      data: await this.service.access(
        authState(res).user.id,
        positiveId(req.params.id),
        oneOf(
          req.body.status,
          ["active", "suspended", "revoked"] as const,
          "Access status",
        ),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
      ),
    });
  };
  role = async (req: Request, res: Response) => {
    const allowed = [
      "member",
      "staff",
      "admin",
      "subscriber",
      "day_pass",
      "instructor",
    ] as const;
    const primary = oneOf(
      req.body.primaryRole ?? req.body.role,
      allowed,
      "Primary role",
    );
    const roles = req.body.roles === undefined ? undefined : req.body.roles;
    if (
      roles !== undefined &&
      (!Array.isArray(roles) ||
        roles.length === 0 ||
        roles.length > allowed.length ||
        roles.some(
          (r: unknown) =>
            typeof r !== "string" ||
            !allowed.includes(r as (typeof allowed)[number]),
        ) ||
        new Set(roles).size !== roles.length ||
        !roles.includes(primary))
    )
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Select distinct roles including the primary role.",
      );
    if (
      req.body.isStudent !== undefined &&
      typeof req.body.isStudent !== "boolean"
    )
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Student classification must be true or false.",
      );
    res.json({
      data: await this.service.role(
        authState(res).user.id,
        positiveId(req.params.id),
        primary,
        revisionField(req.body.revision),
        reasonField(req.body.reason),
        roles,
        req.body.isStudent,
      ),
    });
  };
  issue = async (req: Request, res: Response) => {
    const result = await this.service.issue(
      authState(res).user.id,
      positiveId(req.params.id),
      issueInput(req.body),
    );
    res.status(result.replayed ? 200 : 201).json({ data: result });
  };
  entitlement = async (req: Request, res: Response) => {
    res.json({
      data: await this.service.entitlementStatus(
        authState(res).user.id,
        positiveId(req.params.id),
        oneOf(
          req.params.kind,
          ["membership", "day_pass"] as const,
          "Entitlement kind",
        ),
        positiveId(req.params.entitlementId),
        oneOf(
          req.body.status,
          ["active", "suspended", "revoked"] as const,
          "Status",
        ),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
      ),
    });
  };
  payments = async (req: Request, res: Response) => {
    const offset = pageOffset(req.query.offset);
    res.json({
      data: page(
        await this.model.payments(
          req.query.userId == null ? null : positiveId(req.query.userId),
          offset,
        ),
        offset,
      ),
    });
  };
  payment = async (req: Request, res: Response) => {
    const status = oneOf(
      req.body.status,
      ["paid", "void", "waived", "refunded"] as const,
      "Payment status",
    );
    const method = paymentMethod(req.body.method);
    validatePaymentMethod(status, method);
    res.json({
      data: await this.service.paymentStatus(
        authState(res).user.id,
        positiveId(req.params.id),
        status,
        method,
        textField(req.body.reference ?? "", "External reference", 100, 0),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
      ),
    });
  };
  audits = async (req: Request, res: Response) => {
    const offset = pageOffset(req.query.offset);
    const from = optionalInstant(req.query.from);
    const to = optionalInstant(req.query.to);
    if (from && to && from > to)
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Audit start time must not be after the end time.",
      );
    res.json({
      data: page(
        await this.model.audits(
          {
            userId: optionalPositiveId(req.query.userId, "User"),
            actorId: optionalPositiveId(req.query.actorId, "Actor"),
            action: optionalAuditAction(req.query.action),
            from,
            to,
          },
          offset,
        ),
        offset,
      ),
    });
  };
  policies = async (_req: Request, res: Response) => {
    res.json({ data: await this.model.policies() });
  };
  compliance = async (req: Request, res: Response) => {
    const filters = {
      waiverId: optionalPositiveId(req.query.waiverId, "Waiver"),
      certificationId: optionalPositiveId(req.query.certificationId, "Certification"),
      expiresWithinDays: optionalDays(req.query.expiresWithinDays),
      userStatus: oneOf(
        String(req.query.userStatus ?? "active"),
        ["active", "inactive", "all"] as const,
        "User status",
      ),
      offset: pageOffset(req.query.offset),
    };
    if (req.query.format === "csv") {
      const report = await this.model.compliance({ ...filters, offset: 0 }, true);
      if (report.filteredCount > COMPLIANCE_EXPORT_LIMIT)
        throw new AppError(
          413,
          "EXPORT_TOO_LARGE",
          `Compliance export is limited to ${COMPLIANCE_EXPORT_LIMIT} rows. Narrow the filters and try again.`,
        );
      const headers = [
        "User ID",
        "First name",
        "Last name",
        "Email",
        "Account status",
        "Access status",
        "Waiver compliant",
        "Certification compliant",
        "Missing or expired waivers",
        "Waivers expired or expiring in window",
        "Missing or expired certifications",
        "Certifications expired or expiring in window",
      ];
      const rows = report.users.map((u: any) => [
        u.id,
        u.firstName,
        u.lastName,
        u.email,
        u.status,
        u.accessStatus,
        u.waiverCompliant ? "yes" : "no",
        u.certificationCompliant ? "yes" : "no",
        u.missingWaivers,
        u.expiringWaivers,
        u.missingCertifications,
        u.expiringCertifications,
      ]);
      res
        .type("text/csv")
        .set("Content-Disposition", 'attachment; filename="compliance-report.csv"')
        .send([headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"));
      return;
    }
    const report = await this.model.compliance(filters, false);
    res.json({
      data: {
        ...report,
        users: page(report.users, filters.offset),
        options: await this.model.complianceOptions(),
      },
    });
  };
  publishPolicy = async (req: Request, res: Response) => {
    res.status(201).json({
      data: await this.service.publishPolicy(authState(res).user.id, {
        name: textField(req.body.name, "Policy name", 100),
        version: textField(req.body.version, "Version", 50),
        description: textField(req.body.description, "Policy text", 16000, 20),
        effectiveAt: instant(req.body.effectiveAt),
        approvalReference: textField(
          req.body.approvalReference,
          "Approval/source reference",
          500,
          3,
        ),
        reason: reasonField(req.body.reason),
      }),
    });
  };
  retirePolicy = async (req: Request, res: Response) => {
    res.json({
      data: await this.service.retirePolicy(
        authState(res).user.id,
        positiveId(req.params.id),
        reasonField(req.body.reason),
      ),
    });
  };
}
