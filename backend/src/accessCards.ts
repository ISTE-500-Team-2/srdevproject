// Card assignment and enrollment routes. Fingerprint locks serialize competing assignments of the
// same physical card.

import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requireStaffPermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import { AccessCardRepository } from "./models/access/cards.js";
import { CardEnrollmentRepository } from "./models/access/enrollments.js";
import { assertManageable } from "./services/StaffService.js";
import {
  cardIdentity,
  enrollmentId,
  ReaderRegistry,
  requireDeviceConfig,
} from "./readerRegistry.js";

async function assertUnassigned(db: Database, hash: string) {
  const current = await new AccessCardRepository(db).activeHolder(hash);
  if (current)
    throw new AppError(
      409,
      "CARD_ALREADY_ASSIGNED",
      `This card is already assigned to ${current.name} (${current.label}). Revoke that assignment before reissuing it.`,
    );
}
export function accessCards(pool: Pool, tz: string, registry: ReaderRegistry) {
  const routes = Router(),
    read = requireStaffPermission(pool, "user", "read"),
    write = requireStaffPermission(pool, "user_access", "update");
  routes.get("/admin/access/cards", read, async (req, res) => {
    const userId = positiveId(req.query.userId);
    const data = await new AccessCardRepository(pool).memberCards(userId);
    res.json({ data });
  });
  routes.post(
    "/admin/access/cards/lookup",
    read,
    requireCsrf,
    async (req, res) => {
      const cards = new AccessCardRepository(pool);
      let hash: string;
      if (req.body.eventId !== undefined) {
        const event = await cards.eventFingerprint(
          positiveId(req.body.eventId),
        );
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
      const data = await cards.lookup(hash);
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
      const cards = new AccessCardRepository(db),
        enrollments = new CardEnrollmentRepository(db);
      if (!(await cards.lockMember(userId)))
        throw new AppError(404, "NOT_FOUND", "Member not found.");
      await assertManageable(db, authState(res).user, userId);
      let hash: string, last4: string, sessionId: string | undefined;
      if (req.body.enrollmentId !== undefined) {
        sessionId = enrollmentId(req.body.enrollmentId);
        const session = await enrollments.lockForAssignment(sessionId, actor);
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
      await cards.lockFingerprint(hash);
      if (req.body.replaceCardId !== undefined) {
        const oldId = positiveId(req.body.replaceCardId);
        const before = await cards.lockMemberCard(oldId, userId);
        if (
          !before?.active ||
          before.revision !== positiveId(req.body.expectedRevision)
        )
          throw new AppError(
            409,
            "STALE_RECORD",
            "The card being replaced changed. Refresh and review it before trying again.",
          );
        const after = await cards.deactivate(oldId);
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
      const after = await cards.assign(userId, hash, last4, label, actor);
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
      if (sessionId) await enrollments.complete(sessionId);
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
          const cards = new AccessCardRepository(db);
          if (action === "reactivate") {
            requireDeviceConfig(registry.config);
            const card = await cards.fingerprint(id);
            if (!card) throw new AppError(404, "NOT_FOUND", "Card not found.");
            await cards.lockFingerprint(card.uid_hash);
          }
          const before = await cards.lockCard(id);
          if (!before) throw new AppError(404, "NOT_FOUND", "Card not found.");
          await assertManageable(db, authState(res).user, before.user_id);
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
          const after = await cards.setActive(id, active);
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
