import { accessDeadline } from './accessDeadline.js';
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { UserModel } from "./models/UserModel.js";
import { AccessService, type AccessTarget } from "./services/AccessService.js";
import { StaffModel } from "./models/StaffModel.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
export interface Reader {
  id: string;
  secret: string;
  kind: "building" | "room" | "equipment";
  resourceId?: number;
}
export interface DeviceConfig {
  cardHashKey: string;
  readers: Reader[];
}
export function readDeviceConfig(): DeviceConfig | undefined {
  if (!process.env.ACCESS_READERS_JSON) return undefined;
  const readers = JSON.parse(process.env.ACCESS_READERS_JSON),
    cardHashKey = process.env.ACCESS_CARD_HASH_KEY ?? "";
  if (
    cardHashKey.length < 32 ||
    !Array.isArray(readers) ||
    readers.length < 1 ||
    readers.length > 100
  )
    throw Error("Invalid device access configuration");
  const ids = new Set();
  for (const r of readers) {
    if (
      typeof r.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) ||
      ids.has(r.id) ||
      typeof r.secret !== "string" ||
      r.secret.length < 32 ||
      !["building", "room", "equipment"].includes(r.kind) ||
      ((r.kind !== "building" || r.resourceId !== undefined) &&
        (!Number.isSafeInteger(r.resourceId) || r.resourceId < 1))
    )
      throw Error("Invalid reader configuration");
    ids.add(r.id);
  }
  return { readers, cardHashKey };
}
function uidHash(uid: unknown, c: DeviceConfig) {
  if (typeof uid !== "string")
    throw new AppError(400, "INVALID_UID", "Use a 4, 7 or 10 byte card UID.");
  const value = uid.replace(/[: -]/g, "").toUpperCase();
  if (!/^(?:[A-F0-9]{8}|[A-F0-9]{14}|[A-F0-9]{20})$/.test(value))
    throw new AppError(400, "INVALID_UID", "Use a 4, 7 or 10 byte card UID.");
  return createHmac("sha256", c.cardHashKey).update(value).digest("hex");
}
export function deviceDecision(
  pool: Pool,
  timeZone: string,
  c?: DeviceConfig,
): RequestHandler {
  return async (req, res) => {
    if (!c)
      throw new AppError(
        503,
        "DEVICES_NOT_CONFIGURED",
        "Device access is not configured.",
      );
    const reader = c.readers.find((r) => r.id === req.get("X-Reader-ID")),
      stamp = req.get("X-Reader-Timestamp") ?? "",
      signature = req.get("X-Reader-Signature") ?? "";
    if (
      !reader ||
      !/^\d{13}$/.test(stamp) ||
      Math.abs(Date.now() - Number(stamp)) > 15000 ||
      !Buffer.isBuffer(req.body) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new AppError(
        401,
        "DEVICE_AUTH_REQUIRED",
        "Device authentication failed.",
      );
    const expected = createHmac("sha256", reader.secret)
      .update(stamp + "\n")
      .update(req.body)
      .digest();
    if (!timingSafeEqual(Buffer.from(signature, "hex"), expected))
      throw new AppError(
        401,
        "DEVICE_AUTH_REQUIRED",
        "Device authentication failed.",
      );
    let body: any;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new AppError(400, "INVALID_JSON", "Invalid request.");
    }
    if (
      !body ||
      typeof body.eventId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.eventId,
      )
    )
      throw new AppError(
        400,
        "INVALID_EVENT",
        "A fresh event UUID is required.",
      );
    const hash = uidHash(body.uid, c);
    const decision = await transaction(pool, async (db) => {
      await db.query("SET LOCAL statement_timeout=1500");
      await db.query("SET LOCAL lock_timeout=500");
      const existing = await db.query(
        "SELECT id FROM app_device_access_event WHERE reader_id=$1 AND request_id=$2",
        [reader.id, body.eventId],
      );
      if (existing.rowCount)
        throw new AppError(409, "REPLAYED_EVENT", "Use a fresh event ID.");
      const card = (
        await db.query(
          "SELECT user_id FROM app_access_card WHERE uid_hash=$1 AND active=true FOR SHARE",
          [hash],
        )
      ).rows[0];
      const verdict = await evaluate(db, timeZone, reader, card?.user_id);
      const saved = (
        await db.query(
          `INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            reader.id,
            body.eventId,
            card?.user_id ?? null,
            reader.kind,
            reader.resourceId ?? null,
            verdict.allowed,
            verdict.reason,
            verdict.expiresAt,
          ],
        )
      ).rows[0];
      if (verdict.allowed && body.checkIn === true)
        await db.query(
          `INSERT INTO check_in(userid,roomid,location,buildingid,equipmentid,reservationid,checkintime,status,statusdesc) VALUES($1,$2,$3,$4,$5,$6,NOW() AT TIME ZONE 'UTC','approved','Authenticated NFC eligibility decision')`,
          [
            card.user_id,
            reader.kind === "room" ? reader.resourceId : null,
            reader.id,
            verdict.buildingId,
            reader.kind === 'equipment' ? reader.resourceId : null,
            verdict.reservationId,
          ],
        );
      return {
        eventId: body.eventId,
        decisionId: saved.id,
        readerId: reader.id,
        ...verdict,
      };
    });
    res.json({ data: decision });
  };
}
async function evaluate(db: Database, tz: string, r: Reader, userId?: number) {
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
export function cardManagement(pool: Pool, tz: string, c?: DeviceConfig) {
  const routes = Router(),
    permit = requirePermission(pool, "user_access", "update");
  routes.get(
    "/admin/access/cards",
    requirePermission(pool, "user", "read"),
    async (req, res) => {
      const id = positiveId(req.query.userId);
      res.json({
        data: (
          await pool.query(
            'SELECT id,label,active,revision,assigned_at AS "assignedAt" FROM app_access_card WHERE user_id=$1 ORDER BY id',
            [id],
          )
        ).rows,
      });
    },
  );
  routes.post("/admin/access/cards", permit, requireCsrf, async (req, res) => {
    if (!c)
      throw new AppError(
        503,
        "DEVICES_NOT_CONFIGURED",
        "Device access is not configured.",
      );
    const userId = positiveId(req.body.userId),
      label = textField(req.body.label, "Card label", 100),
      reason = textField(req.body.reason, "Reason", 500),
      hash = uidHash(req.body.uid, c);
    const data = await transaction(pool, async (db) => {
      const after = (
        await db.query(
          "INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,$3,$4) RETURNING id,user_id,label,active,revision",
          [userId, hash, label, authState(res).user.id],
        )
      ).rows[0];
      await new StaffModel(db, tz).audit(
        authState(res).user.id,
        userId,
        "access.card_assigned",
        "access_card",
        after.id,
        reason,
        null,
        after,
      );
      return after;
    });
    res.status(201).json({ data });
  });
  routes.post(
    "/admin/access/cards/:id/revoke",
    permit,
    requireCsrf,
    async (req, res) => {
      const data = await transaction(pool, async (db) => {
        const id = positiveId(req.params.id),
          before = (
            await db.query(
              "SELECT id,user_id,label,active,revision FROM app_access_card WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
        if (!before) throw new AppError(404, "NOT_FOUND", "Card not found.");
        if (before.revision !== positiveId(req.body.expectedRevision))
          throw new AppError(
            409,
            "STALE_RECORD",
            "Refresh card before revoking.",
          );
        const after = (
          await db.query(
            "UPDATE app_access_card SET active=false,revision=revision+1 WHERE id=$1 RETURNING id,user_id,label,active,revision",
            [id],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          authState(res).user.id,
          before.user_id,
          "access.card_revoked",
          "access_card",
          id,
          textField(req.body.reason, "Reason", 500),
          before,
          after,
        );
        return after;
      });
      res.json({ data });
    },
  );
  routes.get(
    "/admin/access/overrides",
    requirePermission(pool, "user", "read"),
    async (req, res) => {
      const userId = positiveId(req.query.userId);
      res.json({
        data: (
          await pool.query(
            'SELECT id,target_kind AS kind,target_id AS "resourceId",ends_at AS "endsAt",reason,revoked_at AS "revokedAt" FROM app_access_override WHERE user_id=$1 ORDER BY id DESC LIMIT 100',
            [userId],
          )
        ).rows,
      });
    },
  );
  routes.post(
    "/admin/access/overrides",
    permit,
    requireCsrf,
    async (req, res) => {
      const userId = positiveId(req.body.userId),
        kind = req.body.kind,
        id = positiveId(req.body.resourceId),
        ends = new Date(req.body.endsAt),
        reason = textField(req.body.reason, "Reason", 500);
      if (
        !["room", "equipment"].includes(kind) ||
        !Number.isFinite(ends.getTime()) ||
        ends <= new Date() ||
        ends.getTime() > Date.now() + 30 * 60000
      )
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Override must end within 30 minutes.",
        );
      const data = await transaction(pool, async (db) => {
        await new AccessService(db,tz).assertActiveUser(userId);
        const table = kind === "room" ? "room" : "equipment",
          key = kind === "room" ? "roomid" : "equipmentid";
        const resource = (await db.query<{name: string; status: string}>(
          `SELECT name,status FROM ${table} WHERE ${key}=$1 FOR UPDATE`,[id])).rows[0];
        if (!resource) throw new AppError(404,'NOT_FOUND','Resource not found.');
        if (resource.status !== 'available') throw new AppError(409,'RESOURCE_UNAVAILABLE','This resource is unavailable.');
        const current = (await db.query<{id: number; endsAt: Date}>(
          `SELECT reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt" FROM reservation
            WHERE userid=$1 AND ${key}=$2 AND status='confirmed' AND starttime<=NOW() AT TIME ZONE 'UTC'
            AND endtime>NOW() AT TIME ZONE 'UTC' ORDER BY endtime LIMIT 1 FOR UPDATE`,[userId,id])).rows[0];
        const reservation = current ?? (await db.query<{id: number; endsAt: Date}>(
          `INSERT INTO reservation(userid,${key},location,starttime,endtime,status,statusdesc)
           VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed','Staff supervised access')
           RETURNING reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt"`,[userId,id,resource.name.slice(0,100),ends])).rows[0]!;
        if (!current) await new StaffModel(db,tz).audit(authState(res).user.id,userId,'reservation.created',
          'reservation',reservation.id,reason,null,reservation);
        const effectiveEnd = new Date(Math.min(ends.getTime(),reservation.endsAt.getTime()));
        const after = (
          await db.query(
            "INSERT INTO app_access_override(user_id,target_kind,target_id,ends_at,reason,created_by,reservationid,owns_reservation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [userId,kind,id,effectiveEnd,reason,authState(res).user.id,reservation.id,!current],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          authState(res).user.id,
          userId,
          "access.override_created",
          "access_override",
          after.id,
          reason,
          null,
          after,
        );
        return after;
      });
      res.status(201).json({ data });
    },
  );
  routes.post(
    "/admin/access/overrides/:id/revoke",
    permit,
    requireCsrf,
    async (req, res) => {
      const data = await transaction(pool, async (db) => {
        const id = positiveId(req.params.id),
          before = (
            await db.query(
              "SELECT * FROM app_access_override WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
        if (!before)
          throw new AppError(404, "NOT_FOUND", "Override not found.");
        if (before.owns_reservation && !before.revoked_at) {
          const cancelled = (await db.query(
            "UPDATE reservation SET status='cancelled',revision=revision+1 WHERE reservationid=$1 AND userid=$2 AND status='confirmed' RETURNING reservationid AS id",
            [before.reservationid,before.user_id])).rows[0];
          if (cancelled) await new StaffModel(db,tz).audit(authState(res).user.id,before.user_id,
            'reservation.override.cancelled','reservation',cancelled.id,'Staff supervision ended',null,cancelled);
        }
        const after = (
          await db.query(
            "UPDATE app_access_override SET revoked_at=NOW() WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          authState(res).user.id,
          before.user_id,
          "access.override_revoked",
          "access_override",
          id,
          textField(req.body.reason, "Reason", 500),
          before,
          after,
        );
        return after;
      });
      res.json({ data });
    },
  );
  return routes;
}
