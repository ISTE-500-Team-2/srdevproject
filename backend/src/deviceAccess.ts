import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { UserModel } from "./models/UserModel.js";
import { EligibilityModel } from "./models/EligibilityModel.js";
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
      (r.kind !== "building" &&
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
          `INSERT INTO check_in(userid,roomid,location,checkintime,status,statusdesc) VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC','approved','Authenticated NFC eligibility decision')`,
          [
            card.user_id,
            reader.kind === "room" ? reader.resourceId : null,
            reader.id,
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
  });
  if (!userId) return deny("CARD_NOT_ASSIGNED");
  await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [
    userId,
  ]);
  const user = await new UserModel(db).findById(userId);
  if (!user || user.status !== "active" || user.accessStatus !== "active")
    return deny("ACCOUNT_BLOCKED");
  const eligibility = new EligibilityModel(db, tz),
    now = new Date();
  const entitlement = await eligibility.entitlement(userId, now);
  if (!entitlement.membership && !entitlement.dayPass)
    return deny("ENTITLEMENT_REQUIRED");
  const waivers = await eligibility.waivers(userId);
  if (!waivers.length) return deny("WAIVERS_NOT_CONFIGURED");
  if (waivers.some((w) => !w.signed)) return deny("WAIVER_REQUIRED");
  let expires = new Date(now.getTime() + 5000);
  // An override bypasses only the reservation requirement, never safety checks.
  if (r.kind !== "building") {
    const resource = (
      await db.query(
        r.kind === "equipment"
          ? "SELECT status,certid FROM equipment WHERE equipmentid=$1 FOR SHARE"
          : "SELECT status,NULL::int AS certid FROM room WHERE roomid=$1 FOR SHARE",
        [r.resourceId],
      )
    ).rows[0];
    if (!resource || resource.status !== "available")
      return deny("RESOURCE_UNAVAILABLE");
    if (
      resource.certid &&
      !(await eligibility.certification(userId, resource.certid, now))
    )
      return deny("CERTIFICATION_REQUIRED");
    const key = r.kind === "equipment" ? "equipmentid" : "roomid";
    const booking = (
      await db.query(
        `SELECT endtime AT TIME ZONE 'UTC' AS ends FROM reservation WHERE userid=$1 AND ${key}=$2 AND status='confirmed' AND starttime<=NOW() AT TIME ZONE 'UTC' AND endtime>NOW() AT TIME ZONE 'UTC' ORDER BY endtime LIMIT 1 FOR SHARE`,
        [userId, r.resourceId],
      )
    ).rows[0];
    const override = booking
      ? null
      : (
          await db.query(
            "SELECT ends_at AS ends FROM app_access_override WHERE user_id=$1 AND target_kind=$2 AND target_id=$3 AND revoked_at IS NULL AND ends_at>NOW() ORDER BY ends_at LIMIT 1 FOR SHARE",
            [userId, r.kind, r.resourceId],
          )
        ).rows[0];
    if (!booking && !override) return deny("RESERVATION_REQUIRED");
    expires = new Date(
      Math.min(
        expires.getTime(),
        new Date((booking ?? override)!.ends).getTime(),
      ),
    );
  }
  // Bound the relay lease by all expiry windows, even near a five-second boundary.
  const limits = (
    await db.query(
      `SELECT LEAST(
  COALESCE((SELECT MAX(end_date AT TIME ZONE 'UTC') FROM user_membership WHERE userid=$1 AND status='active' AND startdate<=NOW() AT TIME ZONE 'UTC' AND end_date>NOW() AT TIME ZONE 'UTC'),
    ((NOW() AT TIME ZONE $2)::date+1)::timestamp AT TIME ZONE $2),
  COALESCE((SELECT MIN(expires_at) FROM user_waiver WHERE userid=$1 AND approval=true AND expires_at>NOW()),'infinity'::timestamptz)) AS ends`,
      [userId, tz],
    )
  ).rows[0];
  if (limits?.ends instanceof Date)
    expires = new Date(Math.min(expires.getTime(), limits.ends.getTime()));
  if (r.kind === "equipment") {
    const limit = (
      await db.query(
        `SELECT LEAST(uc.renewaldate,c.enddate) AT TIME ZONE 'UTC' AS ends FROM user_certifications uc JOIN certifications c USING(certid) JOIN equipment e USING(certid) WHERE uc.userid=$1 AND e.equipmentid=$2 AND uc.status='active'`,
        [userId, r.resourceId],
      )
    ).rows[0];
    if (limit?.ends instanceof Date)
      expires = new Date(Math.min(expires.getTime(), limit.ends.getTime()));
  }
  if (expires.getTime() <= Date.now()) return deny("ELIGIBILITY_EXPIRED");
  return {
    allowed: true,
    reason: "ELIGIBLE",
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
        const table = kind === "room" ? "room" : "equipment",
          key = kind === "room" ? "roomid" : "equipmentid";
        if (
          !(await db.query(`SELECT ${key} FROM ${table} WHERE ${key}=$1`, [id]))
            .rowCount
        )
          throw new AppError(404, "NOT_FOUND", "Resource not found.");
        const after = (
          await db.query(
            "INSERT INTO app_access_override(user_id,target_kind,target_id,ends_at,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [userId, kind, id, ends, reason, authState(res).user.id],
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
