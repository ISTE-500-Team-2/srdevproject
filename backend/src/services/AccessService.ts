import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { EligibilityModel } from "../models/EligibilityModel.js";

export class AccessService {
  readonly eligibility: EligibilityModel;
  constructor(
    private db: Database,
    timeZone: string,
  ) {
    this.eligibility = new EligibilityModel(db, timeZone);
  }

  async assertActiveUser(userId: number) {
    const { rows } = await this.db.query<{
      status: string;
      accessstatus: string;
    }>('SELECT status,accessstatus FROM "user" WHERE userid=$1 FOR SHARE', [
      userId,
    ]);
    if (rows[0]?.status !== "active")
      throw new AppError(
        403,
        "ACCOUNT_INACTIVE",
        "This account does not currently have access.",
      );
    if (rows[0]?.accessstatus !== "active")
      throw new AppError(
        403,
        "ACCESS_BLOCKED",
        "Facility access is suspended or revoked. Contact staff.",
      );
  }
  async assertEntitlement(userId: number, start: Date, end = start) {
    const value = await this.eligibility.entitlement(userId, start, end);
    if (!value.membership && !value.dayPass)
      throw new AppError(
        403,
        "MEMBERSHIP_REQUIRED",
        "An active membership or valid day pass is required for this time.",
      );
    return value;
  }
  async assertWaivers(userId: number) {
    const waivers = await this.eligibility.waivers(userId);
    if (!waivers.length)
      throw new AppError(
        409,
        "WAIVERS_NOT_CONFIGURED",
        "Staff need to configure the required policies before access can be granted.",
      );
    if (waivers.some((w) => !w.signed))
      throw new AppError(
        403,
        "WAIVER_REQUIRED",
        "Sign all current required policies and waivers first.",
      );
    return waivers;
  }
}
