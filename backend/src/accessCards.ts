import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import {
  cardIdentity,
  enrollmentId,
  ReaderRegistry,
  requireDeviceConfig,
} from "./readerRegistry.js";

const publicCard = 'id,user_id,label,active,revision,uid_last4 AS "last4"';
async function assertUnassigned(db: Database, hash: string) {
  const current = (
    await db.query(
      `SELECT u.firstname || ' ' || u.lastname AS name,c.label
    FROM app_access_card c JOIN "user" u ON u.userid=c.user_id WHERE c.uid_hash=$1 AND c.active`,
      [hash],
    )
  ).rows[0];
  if (current)
    throw new AppError(
      409,
      "CARD_ALREADY_ASSIGNED",
      `This card is already assigned to ${current.name} (${current.label}). Revoke that assignment before reissuing it.`,
    );
}
async function lockFingerprint(db: Database, hash: string) {
  // Serialize assignment/reactivation across members; the partial unique index
  // remains the final guard. A collision only serializes unrelated operations.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hash]);
}
export function accessCards(pool: Pool, tz: string, registry: ReaderRegistry) {
  const routes = Router(),
    read = requirePermission(pool, "user", "read"),
    write = requirePermission(pool, "user_access", "update");
  routes.get("/admin/access/cards", read, async (req, res) => {
    const userId = positiveId(req.query.userId);
    const data = (
      await pool.query(
        `SELECT c.id,c.label,c.active,c.revision,c.uid_last4 AS "last4",c.assigned_at AS "assignedAt",
      a.firstname || ' ' || a.lastname AS "assignedBy",tap.created_at AS "lastUsedAt",tap.reader_name AS "lastReader"
      FROM app_access_card c LEFT JOIN "user" a ON a.userid=c.assigned_by
      LEFT JOIN LATERAL (SELECT e.created_at,COALESCE(r.name,e.reader_id) AS reader_name
        FROM app_device_access_event e LEFT JOIN app_access_reader r ON r.id=e.reader_id
        WHERE e.card_id=c.id AND e.is_tap AND e.allowed ORDER BY e.created_at DESC,e.id DESC LIMIT 1) tap ON true
      WHERE c.user_id=$1 ORDER BY c.active DESC,c.id DESC`,
        [userId],
      )
    ).rows;
    res.json({ data });
  });
  routes.post(
    "/admin/access/cards/lookup",
    read,
    requireCsrf,
    async (req, res) => {
      let hash: string;
      if (req.body.eventId !== undefined) {
        const event = (
          await pool.query(
            "SELECT uid_hash FROM app_device_access_event WHERE id=$1",
            [positiveId(req.body.eventId)],
          )
        ).rows[0];
        if (!event?.uid_hash)
          throw new AppError(
            404,
            "NOT_FOUND",
            "This tap has no saved card fingerprint. Tap the card again to look it up.",
          );
        hash = event.uid_hash;
      } else
        hash = cardIdentity(
          req.body.uid,
          requireDeviceConfig(registry.config),
        ).hash;
      const data = (
        await pool.query(
          `SELECT c.id,c.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      c.label,c.active,c.uid_last4 AS "last4",c.assigned_at AS "assignedAt" FROM app_access_card c JOIN "user" u ON u.userid=c.user_id
      WHERE c.uid_hash=$1 ORDER BY c.active DESC,c.id DESC LIMIT 20`,
          [hash],
        )
      ).rows;
      res.json({ data });
    },
  );
  routes.post("/admin/access/cards", write, requireCsrf, async (req, res) => {
    const config = requireDeviceConfig(registry.config);
    if (!(await registry.list()).some((r) => r.enabled))
      throw new AppError(
        409,
        "NO_ENABLED_READERS",
        "Add or enable a reader before assigning NFC cards.",
      );
    const userId = positiveId(req.body.userId),
      label = textField(req.body.label, "Card label", 100),
      reason = textField(req.body.reason, "Reason", 500);
    const actor = authState(res).user.id;
    const data = await transaction(pool, async (db) => {
      if (
        !(
          await db.query(
            'SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',
            [userId],
          )
        ).rowCount
      )
        throw new AppError(404, "NOT_FOUND", "Member not found.");
      let hash: string, last4: string, sessionId: string | undefined;
      if (req.body.enrollmentId !== undefined) {
        sessionId = enrollmentId(req.body.enrollmentId);
        const session = (
          await db.query(
            `SELECT * FROM app_card_enrollment WHERE id=$1 AND actor_id=$2 FOR UPDATE`,
            [sessionId, actor],
          )
        ).rows[0];
        if (
          !session ||
          session.user_id !== userId ||
          session.purpose !== "assign" ||
          !session.captured_at ||
          session.completed_at ||
          session.cancelled_at ||
          new Date(session.expires_at).getTime() <= Date.now()
        )
          throw new AppError(
            409,
            "INVALID_ENROLLMENT",
            "This scan is no longer available for this member. Start a new scan.",
          );
        hash = session.uid_hash;
        last4 = session.uid_last4;
      } else ({ hash, last4 } = cardIdentity(req.body.uid, config));
      await lockFingerprint(db, hash);
      if (req.body.replaceCardId !== undefined) {
        const oldId = positiveId(req.body.replaceCardId);
        const before = (
          await db.query(
            `SELECT ${publicCard} FROM app_access_card WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [oldId, userId],
          )
        ).rows[0];
        if (
          !before?.active ||
          before.revision !== positiveId(req.body.expectedRevision)
        )
          throw new AppError(
            409,
            "STALE_RECORD",
            "The card being replaced changed. Refresh and review it before trying again.",
          );
        const after = (
          await db.query(
            `UPDATE app_access_card SET active=false,revision=revision+1 WHERE id=$1 RETURNING ${publicCard}`,
            [oldId],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          actor,
          userId,
          "access.card_revoked",
          "access_card",
          oldId,
          reason,
          before,
          after,
        );
      }
      await assertUnassigned(db, hash);
      const after = (
        await db.query(
          `INSERT INTO app_access_card(user_id,uid_hash,uid_last4,label,assigned_by) VALUES($1,$2,$3,$4,$5) RETURNING ${publicCard}`,
          [userId, hash, last4, label, actor],
        )
      ).rows[0];
      await new StaffModel(db, tz).audit(
        actor,
        userId,
        "access.card_assigned",
        "access_card",
        after.id,
        reason,
        null,
        after,
      );
      if (sessionId)
        await db.query(
          "UPDATE app_card_enrollment SET completed_at=NOW() WHERE id=$1",
          [sessionId],
        );
      return after;
    });
    res.status(201).json({ data });
  });
  for (const action of ["revoke", "reactivate"] as const)
    routes.post(
      `/admin/access/cards/:id/${action}`,
      write,
      requireCsrf,
      async (req, res) => {
        const id = positiveId(req.params.id),
          revision = positiveId(req.body.expectedRevision),
          reason = textField(req.body.reason, "Reason", 500);
        const data = await transaction(pool, async (db) => {
          if (action === "reactivate") {
            requireDeviceConfig(registry.config);
            const card = (
              await db.query(
                "SELECT uid_hash FROM app_access_card WHERE id=$1",
                [id],
              )
            ).rows[0];
            if (!card) throw new AppError(404, "NOT_FOUND", "Card not found.");
            await lockFingerprint(db, card.uid_hash);
          }
          const before = (
            await db.query(
              `SELECT ${publicCard},uid_hash FROM app_access_card WHERE id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (!before) throw new AppError(404, "NOT_FOUND", "Card not found.");
          const active = action === "reactivate";
          if (before.active === active)
            throw new AppError(
              409,
              "CARD_STATE_CHANGED",
              `This card is already ${active ? "active" : "revoked"}. Refresh the card list.`,
            );
          if (before.revision !== revision)
            throw new AppError(
              409,
              "STALE_RECORD",
              "This card changed. The latest cards have been loaded; review them and try again.",
            );
          if (active) await assertUnassigned(db, before.uid_hash);
          const after = (
            await db.query(
              `UPDATE app_access_card SET active=$2,revision=revision+1 WHERE id=$1 RETURNING ${publicCard}`,
              [id, active],
            )
          ).rows[0];
          const { uid_hash: _hash, ...safeBefore } = before;
          await new StaffModel(db, tz).audit(
            authState(res).user.id,
            before.user_id,
            `access.card_${active ? "reactivated" : "revoked"}`,
            "access_card",
            id,
            reason,
            safeBefore,
            after,
          );
          return after;
        });
        res.json({ data });
      },
    );
  return routes;
}
