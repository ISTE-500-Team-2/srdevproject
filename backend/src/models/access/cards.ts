// Member access cards (app_access_card), found by member or by the card's fingerprint. Only the
// fingerprint and last four characters of a card's UID are stored.

import type { Database } from "../../db.js";

const publicCard = 'id,user_id,label,active,revision,uid_last4 AS "last4"';

/** A card as staff and the audit trail see it. */
export interface PublicCard {
  id: number;
  user_id: number;
  label: string;
  active: boolean;
  revision: number;
  last4: string;
}

/** Card assignment, revocation and look-up. */
export class AccessCardRepository {
  constructor(private db: Database) {}
  /** A member's cards with who assigned each and where it last opened something. */
  async memberCards(userId: number) {
    return (
      await this.db.query(
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
  }
  /** The card fingerprint a recorded tap saved, if any. */
  async eventFingerprint(eventId: number) {
    return (
      await this.db.query<{ uid_hash: string | null }>(
        "SELECT uid_hash FROM app_device_access_event WHERE id=$1",
        [eventId],
      )
    ).rows[0];
  }
  /** Every assignment of one physical card, current first. */
  async lookup(hash: string) {
    return (
      await this.db.query(
        `SELECT c.id,c.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      c.label,c.active,c.uid_last4 AS "last4",c.assigned_at AS "assignedAt" FROM app_access_card c JOIN "user" u ON u.userid=c.user_id
      WHERE c.uid_hash=$1 ORDER BY c.active DESC,c.id DESC LIMIT 20`,
        [hash],
      )
    ).rows;
  }
  /** Every assignment of the card a scan captured, current first. */
  async scanAssignments(hash: string) {
    return (
      await this.db.query(
        `SELECT c.id,c.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      c.label,c.active,c.assigned_at AS "assignedAt" FROM app_access_card c JOIN "user" u ON u.userid=c.user_id
      WHERE c.uid_hash=$1 ORDER BY c.active DESC,c.id DESC LIMIT 20`,
        [hash],
      )
    ).rows;
  }
  /** Locks the member a card is for (row count). */
  async lockMember(userId: number) {
    return (
      await this.db.query(
        'SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',
        [userId],
      )
    ).rowCount;
  }
  /** Who holds this physical card now, if anyone. */
  async activeHolder(hash: string) {
    return (
      await this.db.query<{ name: string; label: string }>(
        `SELECT u.firstname || ' ' || u.lastname AS name,c.label
    FROM app_access_card c JOIN "user" u ON u.userid=c.user_id WHERE c.uid_hash=$1 AND c.active`,
        [hash],
      )
    ).rows[0];
  }
  async lockFingerprint(hash: string) {
    // Serialize assignment/reactivation across members; the partial unique index
    // remains the final guard. A collision only serializes unrelated operations.
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hash]);
  }
  async lockMemberCard(id: number, userId: number) {
    return (
      await this.db.query<PublicCard>(
        `SELECT ${publicCard} FROM app_access_card WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [id, userId],
      )
    ).rows[0];
  }
  async deactivate(id: number): Promise<PublicCard> {
    return (
      await this.db.query<PublicCard>(
        `UPDATE app_access_card SET active=false,revision=revision+1 WHERE id=$1 RETURNING ${publicCard}`,
        [id],
      )
    ).rows[0]!;
  }
  async assign(
    userId: number,
    hash: string,
    last4: string,
    label: string,
    actorId: number,
  ): Promise<PublicCard> {
    return (
      await this.db.query<PublicCard>(
        `INSERT INTO app_access_card(user_id,uid_hash,uid_last4,label,assigned_by) VALUES($1,$2,$3,$4,$5) RETURNING ${publicCard}`,
        [userId, hash, last4, label, actorId],
      )
    ).rows[0]!;
  }
  async fingerprint(id: number) {
    return (
      await this.db.query<{ uid_hash: string }>(
        "SELECT uid_hash FROM app_access_card WHERE id=$1",
        [id],
      )
    ).rows[0];
  }
  async lockCard(id: number) {
    return (
      await this.db.query<PublicCard & { uid_hash: string }>(
        `SELECT ${publicCard},uid_hash FROM app_access_card WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  async setActive(id: number, active: boolean): Promise<PublicCard> {
    return (
      await this.db.query<PublicCard>(
        `UPDATE app_access_card SET active=$2,revision=revision+1 WHERE id=$1 RETURNING ${publicCard}`,
        [id, active],
      )
    ).rows[0]!;
  }
  /** Locks the member's active cards (row count). */
  async activeCards(userId: number) {
    return (
      await this.db.query(
        "SELECT id FROM app_access_card WHERE user_id=$1 AND active=true FOR SHARE",
        [userId],
      )
    ).rowCount;
  }
}
