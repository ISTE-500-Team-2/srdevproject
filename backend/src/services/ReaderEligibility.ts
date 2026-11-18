// Credential-independent reader verdict shared by signed devices and staff previews; authorization
// expires with the underlying eligibility.

import { accessDeadline } from "../accessDeadline.js";
import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { UserModel } from "../models/UserModel.js";
import { AccessService, type AccessTarget } from "./AccessService.js";
import { DEFAULT_BUILDING_ID } from "../facility.js";
import type { ReaderKind } from "../readerRegistry.js";

// No credentials here: staff previews and signed device decisions share this exact evaluator.
export interface ReaderTarget {
  kind: ReaderKind;
  resourceId?: number;
}

/**
 * Convert expected eligibility failures into reader denial codes and cap a grant by member/sponsor
 * expiry; unexpected faults still propagate.
 */
export async function evaluateReaderAccess(db: Database, tz: string, r: ReaderTarget, userId?: number, renewal = false) {
  const deny = (reason: string) => ({
    allowed: false,
    reason,
    expiresAt: null as string | null,
    leaseSeconds: 0,
    member: null as unknown,
    buildingId: null as number | null,
    reservationId: null as number | null,
    location: null as string | null,
  });
  if (!userId) return deny("CARD_NOT_ASSIGNED");
  // A misconfigured resource reader must never fall back to building entry.
  if (r.kind !== 'building' && (!Number.isInteger(r.resourceId) || r.resourceId! <= 0))
    return deny('RESOURCE_UNAVAILABLE');
  const now = new Date();
  const target: AccessTarget | null = r.kind === 'building' ? {buildingId:r.resourceId ?? DEFAULT_BUILDING_ID}
    : r.kind === 'room' ? {roomId:r.resourceId} : r.kind === 'studio' ? {studioId:r.resourceId}
    : r.kind === 'equipment' ? {equipmentId:r.resourceId} : null;
  // An unknown kind must never fall back to building entry either.
  if (!target) return deny('RESOURCE_UNAVAILABLE');
  let grant: Awaited<ReturnType<AccessService['accessForTarget']>>;
  try {
    grant = await new AccessService(db,tz).accessForTarget(userId,target,now);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reason = error.code === 'ACCOUNT_INACTIVE' || error.code === 'ACCESS_BLOCKED' ? 'ACCOUNT_BLOCKED'
      : error.code === 'MEMBERSHIP_REQUIRED' ? 'ENTITLEMENT_REQUIRED'
      : error.code === 'NOT_FOUND' ? 'RESOURCE_UNAVAILABLE' : error.code;
    return deny(reason);
  }
  if (renewal && grant.sponsorId && !(await db.query(`SELECT id FROM app_facility_visit WHERE user_id=$1
    AND sponsor_id=$2 AND building_id=$3 AND checked_out_at IS NULL
    AND (checked_in_at AT TIME ZONE $4)::date=(now() AT TIME ZONE $4)::date`,[userId,grant.sponsorId,grant.buildingId,tz])).rowCount)
    return deny('MINOR_CHECK_IN_REQUIRED');
  const user = await new UserModel(db, tz).findById(userId);
  if (!user) return deny('ACCOUNT_BLOCKED');
  const entitlement = grant.entitlement;
  let expires = await accessDeadline(db,tz,userId,grant.endsAt,
    r.kind === 'equipment' ? r.resourceId : undefined,now);
  if (grant.sponsorId) {
    const sponsorEnd=await accessDeadline(db,tz,grant.sponsorId,grant.endsAt,undefined,now);
    expires=new Date(Math.min(expires.getTime(),sponsorEnd.getTime()));
  }
  if (expires.getTime() <= Date.now()) return deny("ELIGIBILITY_EXPIRED");
  return {
    allowed: true,
    reason: "ELIGIBLE",
    buildingId: grant.buildingId,
    reservationId: grant.reservationId,
    // The place name a check-in records, as a desk check-in names it.
    location: grant.location,
    expiresAt: expires.toISOString(),
    leaseSeconds: Math.max(0, (expires.getTime() - Date.now()) / 1000),
    member: {
      id: user.id,
      isMinor:user.isMinor ?? false, sponsorName:user.sponsorName ?? null,
      name: user.firstName + " " + user.lastName,
      email: user.email,
      membership: entitlement.membership,
      dayPass: entitlement.dayPass,
    },
  };
}
