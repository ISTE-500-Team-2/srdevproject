import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { StudioStripeConfig } from "../studios/stripe.js";
import { EquipmentModel } from "../models/EquipmentModel.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import { authState } from "../middleware/auth.js";
import { positiveId } from '../domain.js';
import { equipmentPrice } from '../equipmentPricing.js';
import { equipmentEligibility, equipmentReasonText } from '../eligibility.js';

export class EquipmentController {
  quote = async (req: Request, res: Response) => {
    const hours = typeof req.query.hours === 'string' && /^\d+$/.test(req.query.hours) ? Number(req.query.hours) : NaN;
    res.json({ data: await equipmentPrice(this.pool, positiveId(req.params.id), hours) });
  };
  constructor(
    private pool: Pool,
    private timeZone: string,
    // Unused: expired checkout holds are released by the background job in
    // equipmentReconciliation.ts, not by catalogue reads. The router still passes it.
    _stripeConfig?: StudioStripeConfig,
  ) {}
  list = async (_req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const eligibility = new EligibilityModel(this.pool, this.timeZone);
    const [items, entitlement, facilityPolicies, equipmentWaivers] = await Promise.all([
      new EquipmentModel(this.pool).list(),
      eligibility.entitlement(userId, new Date()),
      eligibility.waivers(userId, 'facility'),
      eligibility.waivers(userId, 'equipment'),
    ]);
    // Public summary is intentionally separate from the staff maintenance view.
    const outages = (await this.pool.query(`SELECT equipment_id AS "equipmentId",reason,
      expected_back::text AS "expectedBack",started_at AS "startedAt",ended_at AS "endedAt"
      FROM app_equipment_outage WHERE ended_at IS NULL OR ended_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`, [this.timeZone])).rows;
    // Share occupied intervals only, never another member's identity or booking details.
    const occupied = (await this.pool.query(`SELECT equipmentid AS "equipmentId",
      starttime AT TIME ZONE 'UTC' AS "startTime", endtime AT TIME ZONE 'UTC' AS "endTime"
      FROM reservation WHERE equipmentid IS NOT NULL AND status IN ('pending','confirmed')
      AND endtime + interval '15 minutes' > clock_timestamp() AT TIME ZONE 'UTC'`)).rows;
    const data = await Promise.all(
      items.map(async (item) => {
        const trainingRequired =
          !!item.certId &&
          !(await eligibility.certification(userId, item.certId, new Date()));
        const reasonCodes = equipmentEligibility({
          instructor: authState(res).user.roles.includes("instructor"),
          accessStatus: authState(res).user.accessStatus,
          available: item.status === "available",
          entitlement,
          certified: !trainingRequired,
          waiverRequired: item.waiverRequired,
          facilityWaivers: facilityPolicies,
          equipmentWaivers,
        });
        const openOutage = outages.find(o => o.equipmentId === item.id && !o.endedAt);
        const reasons = reasonCodes.map(code => equipmentReasonText(code, openOutage));
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          rate: item.rate === null ? null : Number(item.rate),
          trainingFeeCents: item.trainingFeeCents,
          trainingMinutes: item.trainingMinutes,
          image: item.image,
          status: item.status,
          occupied: occupied.filter(slot => slot.equipmentId === item.id).map(({startTime, endTime}) => ({startTime, endTime})),
          outages: outages.filter(o => o.equipmentId === item.id),
          trainingRequired,
          waiverRequired: item.waiverRequired,
          certification: item.certification,
          location: item.location,
          canReserve: reasons.length === 0,
          availability: reasons.length
            ? reasons.join(" · ")
            : "Choose a time to check availability",
          reasonCodes,
        };
      }),
    );
    res.json({ data });
  };
}
