import { StaffModel } from "../models/StaffModel.js";
import { transaction } from "../db.js";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { AppError } from "../domain.js";
import { authState } from "../middleware/auth.js";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "../notifications/store.js";

export class NotificationPreferencesController {
  constructor(private pool: Pool) {}
  get = async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({
      data: await getNotificationPreferences(this.pool, authState(res).user.id),
    });
  };
  update = async (req: Request, res: Response) => {
    const { enabled, timeZone } = req.body ?? {};
    if (
      typeof enabled !== "boolean" ||
      typeof timeZone !== "string" ||
      timeZone.length > 100
    )
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Provide notification preference and a valid time zone.",
      );
    let canonical: string;
    try {
      canonical = new Intl.DateTimeFormat("en-US", {
        timeZone,
      }).resolvedOptions().timeZone;
    } catch {
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Choose a valid IANA time zone, such as America/New_York.",
      );
    }
    res.set("Cache-Control", "no-store");
    res.json({
      data: await transaction(this.pool, async (db) => {
        const id = authState(res).user.id;
        const before = await getNotificationPreferences(db, id);
        const after = await updateNotificationPreferences(db, id, {
          enabled,
          timeZone: canonical,
        });
        await new StaffModel(db).audit(
          id,
          id,
          "notifications.preferences_updated",
          "user",
          id,
          "Member changed notification preferences",
          before,
          after,
        );
        return after;
      }),
    });
  };
}
