// Maps HTTP reservation requests to transactional booking and checkout services; ownership and
// permission checks precede mutations.

import { EquipmentBilling } from "../billing/equipment.js";
import { StudioStripe, type StudioStripeConfig } from "../studios/stripe.js";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { AppError, integerId, textField } from "../domain.js";
import { authState } from "../middleware/auth.js";
import { ReservationModel } from "../models/ReservationModel.js";
import { ReservationService } from "../services/ReservationService.js";
import { page } from "../pagination.js";

export class ReservationController {
  constructor(
    private pool: Pool,
    private timeZone: string,
    private stripeConfig?: StudioStripeConfig,
  ) {}
  private billing() { return new EquipmentBilling(this.pool, this.stripeConfig ? new StudioStripe(this.stripeConfig) : undefined, this.timeZone); }
  checkout = async (req: Request, res: Response) => {
    res.json({data: await this.billing().checkout(authState(res).user.id, integerId(req.params.id, "Reservation"))});
  };
  cancelCheckout = async (req: Request, res: Response) => {
    res.json({data: await this.billing().cancelPending(authState(res).user.id, integerId(req.params.id, "Reservation"))});
  };
  list = async (_req: Request, res: Response) => {
    await this.billing().reconcile(authState(res).user.id);
    res.json({
      data: await new ReservationModel(this.pool, this.timeZone).listForUser(
        authState(res).user.id,
      ),
    });
  };
  staffList = async (req: Request, res: Response) => {
    const date = typeof req.query.date === "string" ? req.query.date : "";
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (date && !dateMatch)
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Date must use YYYY-MM-DD format.",
      );
    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
      )
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Date must be a valid calendar date.",
        );
    }
    const userId =
      req.query.userId == null || req.query.userId === ""
        ? null
        : integerId(req.query.userId, "Member");
    const equipmentId =
      req.query.equipmentId == null || req.query.equipmentId === ""
        ? null
        : integerId(req.query.equipmentId, "Equipment");
    const offset =
      req.query.offset == null || req.query.offset === ""
        ? 0
        : Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError(400, "INVALID_INPUT", "Offset must be zero or more.");
    const when = req.query.when == null || req.query.when === "" ? null : req.query.when;
    if (when !== null && when !== "upcoming" && when !== "past")
      throw new AppError(400, "INVALID_INPUT", "When must be upcoming or past.");
    const search =
      req.query.search == null || req.query.search === ""
        ? null
        : textField(req.query.search, "Search", 100);
    const rows = await new ReservationModel(this.pool, this.timeZone).listAll({
      date,
      userId,
      equipmentId,
      offset,
      when,
      search,
      // The upcoming and past lists hide cancellations unless asked; the day list keeps them.
      includeCancelled: when === null || req.query.includeCancelled === "true",
    });
    res.json({
      data: page(rows, offset),
    });
  };
  /** One reservation as staff see it now, so a form refused as out of date can catch up. */
  staffGet = async (req: Request, res: Response) => {
    const reservation = await new ReservationModel(this.pool, this.timeZone).find(integerId(req.params.id, "Reservation"));
    if (!reservation) throw new AppError(404, "NOT_FOUND", "Reservation not found.");
    res.json({ data: reservation });
  };
  create = async (req: Request, res: Response) => {
    res.status(201).json({
      data: await new ReservationService(this.pool, this.timeZone, this.stripeConfig ? new StudioStripe(this.stripeConfig) : undefined).create(
        authState(res).user.id,
        req.body,
      ),
    });
  };
  update = async (req: Request, res: Response) => {
    res.json({
      data: await new ReservationService(this.pool, this.timeZone).update(
        authState(res).user.id,
        integerId(req.params.id, "Reservation"),
        req.body,
      ),
    });
  };
  staffCancel = async (req: Request, res: Response) => {
    // A revision sent by the client must still be current, so a booking a colleague moved is not
    // cancelled from the old details. Older clients that send none keep the unconditional cancel.
    const expectedRevision: unknown = req.body?.expectedRevision;
    res.json({
      data: await new ReservationService(this.pool, this.timeZone).cancelAny(
        authState(res).user.id,
        integerId(req.params.id, "Reservation"),
        expectedRevision == null ? undefined : { expectedRevision },
      ),
    });
  };
  cancel = async (req: Request, res: Response) => {
    res.json({
      data: await new ReservationService(this.pool, this.timeZone).cancel(
        authState(res).user.id,
        integerId(req.params.id, "Reservation"),
      ),
    });
  };
}
