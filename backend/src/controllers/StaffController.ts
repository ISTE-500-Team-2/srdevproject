import type { Request, Response } from "express";
import type { Pool } from "pg";
import { AppError, positiveId, textField } from "../domain.js";
import { authState } from "../middleware/auth.js";
import { StaffModel } from "../models/StaffModel.js";
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
    res
      .status(201)
      .json({
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
      this.model.audits(id),
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
    res.json({
      data: await this.service.role(
        authState(res).user.id,
        positiveId(req.params.id),
        oneOf(req.body.role, ["member", "staff", "admin"] as const, "Role"),
        revisionField(req.body.revision),
        reasonField(req.body.reason),
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
    res.json({
      data: page(
        await this.model.audits(
          req.query.userId == null ? null : positiveId(req.query.userId),
          offset,
        ),
        offset,
      ),
    });
  };
  policies = async (_req: Request, res: Response) => {
    res.json({ data: await this.model.policies() });
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
