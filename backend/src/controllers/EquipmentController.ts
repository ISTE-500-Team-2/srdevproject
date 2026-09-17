import type { Request, Response } from "express";
import type { Pool } from "pg";
import { EquipmentModel } from "../models/EquipmentModel.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import { authState } from "../middleware/auth.js";

export class EquipmentController {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}
  list = async (_req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const eligibility = new EligibilityModel(this.pool, this.timeZone);
    const [items, entitlement, waivers] = await Promise.all([
      new EquipmentModel(this.pool).list(),
      eligibility.entitlement(userId, new Date()),
      eligibility.waivers(userId),
    ]);
    const data = await Promise.all(
      items.map(async (item) => {
        const trainingRequired =
          !!item.certId &&
          !(await eligibility.certification(userId, item.certId, new Date()));
        const reasons: string[] = [];
        if (authState(res).user.accessStatus !== "active")
          reasons.push("Facility access is suspended or revoked");
        if (item.status !== "available") reasons.push("Equipment unavailable");
        if (!entitlement.membership && !entitlement.dayPass)
          reasons.push("Membership or day pass required");
        if (trainingRequired) reasons.push("Current certification required");
        if (
          item.waiverRequired &&
          (!waivers.length || waivers.some((w) => !w.signed))
        )
          reasons.push("Signed waivers required");
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          rate: item.rate === null ? null : Number(item.rate),
          image: item.image,
          status: item.status,
          trainingRequired,
          waiverRequired: item.waiverRequired,
          certification: item.certification,
          location: item.location,
          canReserve: reasons.length === 0,
          availability: reasons.length
            ? reasons.join(" · ")
            : "Choose a time to check availability",
        };
      }),
    );
    res.json({ data });
  };
}
