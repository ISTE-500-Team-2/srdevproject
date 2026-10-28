import { evaluateReaderAccess } from "./services/ReaderEligibility.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import {
  accessTransaction,
  AccessDeadlineError,
} from "./services/AccessTransaction.js";
import { AccessService } from "./services/AccessService.js";
import { StaffModel } from "./models/StaffModel.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import {
  cardIdentity,
  ReaderRegistry,
  readerColumns,
  requireDeviceConfig,
  type StoredReader,
  type DeviceConfig,
} from "./readerRegistry.js";
import { readerManagement } from "./readerManagement.js";
import { accessCards } from "./accessCards.js";
export type { Reader, DeviceConfig } from "./readerRegistry.js";
export function readDeviceConfig(): DeviceConfig | undefined {
  if (!process.env.ACCESS_READERS_JSON && !process.env.ACCESS_CARD_HASH_KEY)
    return undefined;
  const readers = JSON.parse(process.env.ACCESS_READERS_JSON ?? "[]"),
    cardHashKey = process.env.ACCESS_CARD_HASH_KEY ?? "";
  if (
    cardHashKey.length < 32 ||
    !Array.isArray(readers) ||
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
export function deviceDecision(
  pool: Pool,
  timeZone: string,
  c?: DeviceConfig,
  registry = new ReaderRegistry(pool, c),
): RequestHandler {
  return async (req, res) => {
    const config = requireDeviceConfig(c);
    const readerId = req.get("X-Reader-ID") ?? "",
      stamp = req.get("X-Reader-Timestamp") ?? "",
      signature = req.get("X-Reader-Signature") ?? "";
    const authError = () =>
      new AppError(
        401,
        "DEVICE_AUTH_REQUIRED",
        "Device authentication failed.",
      );
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(readerId) ||
      !/^\d{13}$/.test(stamp) ||
      Math.abs(Date.now() - Number(stamp)) > 15000 ||
      !Buffer.isBuffer(req.body) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw authError();
    const decision = await accessTransaction(pool, async (db) => {
      // This lock also orders disable/enrollment commands against physical taps.
      const reader = (
        await db.query<StoredReader>(
          `SELECT ${readerColumns} FROM app_access_reader WHERE id=$1 FOR UPDATE`,
          [readerId],
        )
      ).rows[0];
      if (!reader) throw authError();
      const expected = createHmac(
        "sha256",
        registry.decrypt(reader.secretEncrypted),
      )
        .update(stamp + "\n")
        .update(req.body)
        .digest();
      if (!timingSafeEqual(Buffer.from(signature, "hex"), expected))
        throw authError();
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
      if (
        (body.renewal !== undefined && typeof body.renewal !== "boolean") ||
        (body.action !== undefined && body.action !== "heartbeat")
      )
        throw new AppError(400, "INVALID_INPUT", "Invalid reader operation.");
      await db.query(
        "UPDATE app_access_reader SET last_seen_at=NOW() WHERE id=$1",
        [reader.id],
      );
      const enrollment = (
        await db.query(
          `SELECT id,purpose,captured_at,expires_at FROM app_card_enrollment
        WHERE reader_id=$1 AND cancelled_at IS NULL AND completed_at IS NULL AND expires_at>NOW() FOR UPDATE`,
          [reader.id],
        )
      ).rows[0];
      const mode = !reader.enabled
        ? "disabled"
        : enrollment
          ? "enroll"
          : "access";
      const deny = (reason: string) => ({
        allowed: false,
        reason,
        expiresAt: null,
        leaseSeconds: 0,
        member: null,
        buildingId: null,
        reservationId: null,
      });
      if (body.action === "heartbeat")
        return {
          eventId: body.eventId,
          readerId: reader.id,
          mode,
          enrollmentExpiresAt: enrollment?.expires_at ?? null,
          ...deny("HEARTBEAT"),
        };
      const { hash, last4 } = cardIdentity(body.uid, config);
      if (
        (
          await db.query(
            "SELECT id FROM app_device_access_event WHERE reader_id=$1 AND request_id=$2",
            [reader.id, body.eventId],
          )
        ).rowCount
      )
        throw new AppError(409, "REPLAYED_EVENT", "Use a fresh event ID.");
      const card = (
        await db.query(
          "SELECT id,user_id,active FROM app_access_card WHERE uid_hash=$1 ORDER BY active DESC,id DESC LIMIT 1 FOR SHARE",
          [hash],
        )
      ).rows[0];
      // New clients distinguish scans from renewals. Legacy check-ins are scans;
      // legacy renewals cannot consume the next-card enrollment slot.
      const physicalTap =
        body.renewal === false ||
        (body.renewal === undefined && body.checkIn === true);
      let verdict;
      if (!reader.enabled) verdict = deny("READER_DISABLED");
      else if (enrollment) {
        if (physicalTap && !enrollment.captured_at) {
          await db.query(
            `UPDATE app_card_enrollment SET uid_hash=$2,uid_last4=$3,captured_at=NOW(),
            completed_at=CASE WHEN purpose='lookup' THEN NOW() ELSE NULL END WHERE id=$1`,
            [enrollment.id, hash, last4],
          );
          verdict = deny("ENROLLMENT_CAPTURED");
        } else verdict = deny("ENROLLMENT_WAITING");
      } else
        verdict =
          card && !card.active
            ? deny("CARD_REVOKED")
            : await evaluateReaderAccess(db, timeZone, reader, card?.user_id);
      const saved = (
        await db.query(
          `INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at,uid_hash,uid_last4,card_id,is_tap)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            reader.id,
            body.eventId,
            card?.user_id ?? null,
            reader.kind,
            reader.resourceId,
            verdict.allowed,
            verdict.reason,
            verdict.expiresAt,
            hash,
            last4,
            card?.id ?? null,
            body.renewal !== true,
          ],
        )
      ).rows[0];
      if (verdict.allowed && body.checkIn === true && body.renewal !== true)
        await db.query(
          `INSERT INTO check_in(userid,roomid,location,buildingid,equipmentid,reservationid,checkintime,status,statusdesc)
          VALUES($1,$2,$3,$4,$5,$6,NOW() AT TIME ZONE 'UTC','approved','Authenticated NFC eligibility decision')`,
          [
            card.user_id,
            reader.kind === "room" ? reader.resourceId : null,
            reader.id,
            verdict.buildingId,
            reader.kind === "equipment" ? reader.resourceId : null,
            verdict.reservationId,
          ],
        );
      return {
        eventId: body.eventId,
        decisionId: saved.id,
        readerId: reader.id,
        mode,
        ...verdict,
      };
    }, 1800, () => registry.ready()).catch((error) => {
      if (
        error instanceof AccessDeadlineError ||
        error?.code === "57014" ||
        error?.code === "55P03"
      ) {
        let eventId: unknown;
        try {
          eventId = JSON.parse(req.body.toString("utf8")).eventId;
        } catch {
          /* no trusted request body */
        }
        return {
          eventId,
          readerId,
          allowed: false,
          reason: "VERIFICATION_TIMEOUT",
          expiresAt: null,
          leaseSeconds: 0,
          member: null,
          buildingId: null,
          reservationId: null,
          decisionId: null,
        };
      }
      throw error;
    });
    res.json({ data: decision });
  };
}
export function cardManagement(
  pool: Pool,
  tz: string,
  c?: DeviceConfig,
  registry = new ReaderRegistry(pool, c),
) {
  const routes = Router(),
    permit = requirePermission(pool, "user_access", "update");
  routes.use(readerManagement(pool, tz, registry));
  routes.use(accessCards(pool, tz, registry));
  // Advisory only: never inserts an access event/check-in or sends a device command.
  routes.get(
    "/admin/users/:id/access-readiness",
    requirePermission(pool, "user", "read"),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      const configuredReaders = (await registry.list()).filter(
        (r) => r.enabled,
      );
      if (!c || !configuredReaders.length)
        throw new AppError(
          503,
          "DEVICES_NOT_CONFIGURED",
          "No access readers are configured.",
        );
      const userId = positiveId(req.params.id);
      const requested = req.query.readerId;
      if (
        requested !== undefined &&
        (typeof requested !== "string" ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(requested))
      )
        throw new AppError(
          400,
          "INVALID_READER",
          "Choose a configured reader.",
        );
      const reader =
        requested === undefined
          ? configuredReaders[0]!
          : configuredReaders.find((r) => r.id === requested);
      if (!reader)
        throw new AppError(404, "READER_NOT_FOUND", "Reader not found.");
      try {
        const data = await accessTransaction(pool, async (db) => {
          if (
            !(
              await db.query(
                'SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',
                [userId],
              )
            ).rowCount
          )
            throw new AppError(404, "NOT_FOUND", "User not found.");
          const readers = configuredReaders.map((r) => ({
            id: r.id,
            kind: r.kind,
            resourceId: r.resourceId,
            name: r.name,
          }));
          const cardAssigned = !!(
            await db.query(
              "SELECT id FROM app_access_card WHERE user_id=$1 AND active=true FOR SHARE",
              [userId],
            )
          ).rowCount;
          const verdict = await evaluateReaderAccess(
            db,
            tz,
            reader,
            cardAssigned ? userId : undefined,
          );
          return {
            userId,
            readers,
            readerId: reader.id,
            cardAssigned,
            allowed: verdict.allowed,
            reason: verdict.reason,
            checkedAt: new Date().toISOString(),
            expiresAt: verdict.expiresAt,
          };
        });
        res.json({ data });
      } catch (error) {
        if (
          error instanceof AccessDeadlineError ||
          (error as { code?: string })?.code === "57014" ||
          (error as { code?: string })?.code === "55P03"
        )
          throw new AppError(
            503,
            "READINESS_UNAVAILABLE",
            "Access verification timed out. Access readiness is unknown; retry.",
          );
        throw error;
      }
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
            `SELECT o.id,o.target_kind AS kind,o.target_id AS "resourceId",o.ends_at AS "endsAt",o.reason,o.revoked_at AS "revokedAt",
              COALESCE(e.name,r.name,'Unavailable resource') AS "resourceName" FROM app_access_override o
              LEFT JOIN equipment e ON o.target_kind='equipment' AND e.equipmentid=o.target_id
              LEFT JOIN room r ON o.target_kind='room' AND r.roomid=o.target_id WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 100`,
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
        ends =
          req.body.durationMinutes === undefined
            ? new Date(req.body.endsAt)
            : new Date(Date.now() + Number(req.body.durationMinutes) * 60000),
        reason = textField(req.body.reason, "Reason", 500);
      if (
        (req.body.durationMinutes !== undefined &&
          (!Number.isInteger(req.body.durationMinutes) ||
            req.body.durationMinutes < 1 ||
            req.body.durationMinutes > 30)) ||
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
        await new AccessService(db, tz).assertActiveUser(userId);
        const table = kind === "room" ? "room" : "equipment",
          key = kind === "room" ? "roomid" : "equipmentid";
        const resource = (
          await db.query<{ name: string; status: string }>(
            `SELECT name,status FROM ${table} WHERE ${key}=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!resource)
          throw new AppError(404, "NOT_FOUND", "Resource not found.");
        if (resource.status !== "available")
          throw new AppError(
            409,
            "RESOURCE_UNAVAILABLE",
            "This resource is unavailable.",
          );
        const current = (
          await db.query<{ id: number; endsAt: Date }>(
            `SELECT reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt" FROM reservation
            WHERE userid=$1 AND ${key}=$2 AND status='confirmed' AND starttime<=NOW() AT TIME ZONE 'UTC'
            AND endtime>NOW() AT TIME ZONE 'UTC' ORDER BY endtime LIMIT 1 FOR UPDATE`,
            [userId, id],
          )
        ).rows[0];
        const reservation =
          current ??
          (
            await db.query<{ id: number; endsAt: Date }>(
              `INSERT INTO reservation(userid,${key},location,starttime,endtime,status,statusdesc)
           VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed','Staff supervised access')
           RETURNING reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt"`,
              [userId, id, resource.name.slice(0, 100), ends],
            )
          ).rows[0]!;
        if (!current)
          await new StaffModel(db, tz).audit(
            authState(res).user.id,
            userId,
            "reservation.created",
            "reservation",
            reservation.id,
            reason,
            null,
            reservation,
          );
        const effectiveEnd = new Date(
          Math.min(ends.getTime(), reservation.endsAt.getTime()),
        );
        const after = (
          await db.query(
            "INSERT INTO app_access_override(user_id,target_kind,target_id,ends_at,reason,created_by,reservationid,owns_reservation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              userId,
              kind,
              id,
              effectiveEnd,
              reason,
              authState(res).user.id,
              reservation.id,
              !current,
            ],
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
        if (before.revoked_at) return before;
        if (before.owns_reservation) {
          const cancelled = (
            await db.query(
              "UPDATE reservation SET status='cancelled',revision=revision+1 WHERE reservationid=$1 AND userid=$2 AND status='confirmed' RETURNING reservationid AS id",
              [before.reservationid, before.user_id],
            )
          ).rows[0];
          if (cancelled)
            await new StaffModel(db, tz).audit(
              authState(res).user.id,
              before.user_id,
              "reservation.override.cancelled",
              "reservation",
              cancelled.id,
              "Staff supervision ended",
              null,
              cancelled,
            );
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
