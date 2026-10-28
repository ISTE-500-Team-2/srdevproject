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
    // Public summary is intentionally separate from the staff maintenance view.
    const outages = (await this.pool.query(`SELECT equipment_id AS "equipmentId",reason,
      expected_back::text AS "expectedBack",started_at AS "startedAt",ended_at AS "endedAt"
      FROM app_equipment_outage WHERE ended_at IS NULL OR ended_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`, [this.timeZone])).rows;
    const data = await Promise.all(
      items.map(async (item) => {
        const trainingRequired =
          !!item.certId &&
          !(await eligibility.certification(userId, item.certId, new Date()));
        const reasons: string[] = [];
        if (authState(res).user.roles.includes("instructor"))
          reasons.push("Instructor accounts cannot create reservations");
        if (authState(res).user.accessStatus !== "active")
          reasons.push("Facility access is suspended or revoked");
        if (item.status !== "available") {
          const outage = outages.find(o => o.equipmentId === item.id && !o.endedAt);
          const messages: Record<string, string> = { repair: 'Out of service for repair', maintenance: 'Out of service for maintenance', safety: 'Out of service for a safety check', other: 'Temporarily out of service' };
          reasons.push(outage ? messages[outage.reason]! : 'Equipment unavailable');
        }
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
          outages: outages.filter(o => o.equipmentId === item.id),
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
