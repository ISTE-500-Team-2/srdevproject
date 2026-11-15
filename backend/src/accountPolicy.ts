import type { Database } from "./db.js";
import { AppError, type UserView } from "./domain.js";
import { UserModel } from "./models/UserModel.js";
import { PermissionModel } from "./models/PermissionModel.js";
import { DEFAULT_BUSINESS_ZONE } from "./businessDate.js";

export interface ActorRequirements {
  /** Require a staff role with payment-management permission. */
  staff?: boolean;
  /** Require an administrator role. */
  admin?: boolean;
  /** Time zone the account projection is evaluated in. */
  zone?: string;
}

/**
 * Locks the acting account and returns it if it may act: it must be active and
 * not suspended or revoked, and hold the staff or admin roles that are required.
 */
export async function requireActor(
  db: Database,
  id: number,
  { staff = false, admin = false, zone = DEFAULT_BUSINESS_ZONE }: ActorRequirements = {},
): Promise<UserView> {
  await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [id]);
  const user = await new UserModel(db, zone).findById(id);
  if (!user || user.status !== "active" || user.accessStatus !== "active")
    throw new AppError(
      403,
      "ACCESS_DENIED",
      "Your account cannot perform this action.",
    );
  if (
    staff &&
    (!user.roles.some((r) => ["admin", "staff", "super-admin"].includes(r)) ||
      !(await new PermissionModel(db).allows(user, "payment", "update")))
  )
    throw new AppError(
      403,
      "STAFF_REQUIRED",
      "Payment-management permission is required.",
    );
  if (admin && !user.roles.some((r) => ["admin", "super-admin"].includes(r)))
    throw new AppError(
      403,
      "ADMIN_REQUIRED",
      "Administrator permission is required.",
    );
  return user;
}
