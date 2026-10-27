import { accessDeadline } from "../accessDeadline.js";
import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { UserModel } from "../models/UserModel.js";
import { AccessService, type AccessTarget } from "./AccessService.js";

// No credentials here: staff previews and signed device decisions share this exact evaluator.
export interface ReaderTarget {
  kind: "building" | "room" | "equipment";
  resourceId?: number;
}

export async function evaluateReaderAccess(db: Database, tz: string, r: ReaderTarget, userId?: number) {
  const deny = (reason: string) => ({
    allowed: false,
    reason,
    expiresAt: null as string | null,
    leaseSeconds: 0,
    member: null as unknown,
    buildingId: null as number | null,
    reservationId: null as number | null,
  });
  if (!userId) return deny("CARD_NOT_ASSIGNED");
  const now = new Date();
  const target: AccessTarget = r.kind === 'building' ? {buildingId:r.resourceId ?? 1}
    : r.kind === 'room' ? {roomId:r.resourceId} : {equipmentId:r.resourceId};
  let grant: Awaited<ReturnType<AccessService['reservationForAccess']>>;
  try {
    grant = await new AccessService(db,tz).reservationForAccess(userId,target,now);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reason = error.code === 'ACCOUNT_INACTIVE' || error.code === 'ACCESS_BLOCKED' ? 'ACCOUNT_BLOCKED'
      : error.code === 'MEMBERSHIP_REQUIRED' ? 'ENTITLEMENT_REQUIRED'
      : error.code === 'NOT_FOUND' ? 'RESOURCE_UNAVAILABLE' : error.code;
    return deny(reason);
  }
  const user = await new UserModel(db).findById(userId);
  if (!user) return deny('ACCOUNT_BLOCKED');
  const entitlement = grant.entitlement;
  const expires = await accessDeadline(db,tz,userId,grant.endsAt,
    r.kind === 'equipment' ? r.resourceId : undefined,now);
  if (expires.getTime() <= Date.now()) return deny("ELIGIBILITY_EXPIRED");
  return {
    allowed: true,
    reason: "ELIGIBLE",
    buildingId: grant.buildingId,
    reservationId: grant.reservationId,
    expiresAt: expires.toISOString(),
    leaseSeconds: Math.max(0, (expires.getTime() - Date.now()) / 1000),
    member: {
      id: user.id,
      name: user.firstName + " " + user.lastName,
      email: user.email,
      membership: entitlement.membership,
      dayPass: entitlement.dayPass,
    },
  };
}
