// Serves the member equipment catalog and quotes, delegating booking eligibility and prices to
// shared domain services.

import type { Request, Response } from "express";
import type { Pool } from "pg";
import { EquipmentModel } from "../models/EquipmentModel.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import { authState } from "../middleware/auth.js";
import { integerId } from '../domain.js';
import { equipmentPrice } from '../equipmentPricing.js';
import { equipmentEligibility, equipmentReasonText } from '../eligibility.js';

export class EquipmentController {
  quote = async (req: Request, res: Response) => {
    const hours = typeof req.query.hours === 'string' && /^\d+$/.test(req.query.hours) ? Number(req.query.hours) : NaN;
    res.json({ data: await equipmentPrice(this.pool, integerId(req.params.id, 'Equipment'), hours) });
  };
  constructor(
    private pool: Pool,
    private timeZone: string,
    /** Card checkout is configured; without it, priced bookings are paid at the front desk. */
    private cardCheckout = false,
  ) {}
  list = async (_req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const eligibility = new EligibilityModel(this.pool, this.timeZone);
    const now = new Date();
    const [items, entitlement, certified, facilityPolicies, equipmentWaivers] = await Promise.all([
      new EquipmentModel(this.pool).list(),
      // A pass or membership still to come lets members book ahead; the reservation itself checks
      // that it covers the chosen time.
      eligibility.upcomingEntitlement(userId, now),
      eligibility.certifications(userId, now),
      eligibility.waivers(userId, 'facility'),
      eligibility.waivers(userId, 'equipment'),
    ]);
    // Public summary is intentionally separate from the staff maintenance view.
    const equipment = new EquipmentModel(this.pool);
    const outages = await equipment.currentOutages(this.timeZone);
    // Share occupied intervals only, never another member's identity or booking details.
    const occupied = await equipment.occupiedIntervals();
    const data = items.map((item) => {
      const trainingRequired = !!item.certId && !certified.has(item.certId);
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
        cardCheckout: this.cardCheckout,
      };
    });
    res.json({ data });
  };
}
