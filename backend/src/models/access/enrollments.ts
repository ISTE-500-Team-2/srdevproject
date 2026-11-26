// Card scan sessions on a reader (app_card_enrollment): staff start one, the reader captures a
// card into it, and an assignment completes it.

import type { Database } from "../../db.js";

// Time left on a scan by the server's clock, so a browser whose clock is off still counts
// down correctly rather than comparing its own time with expiresAt.
const expiresInMs = `GREATEST(0,EXTRACT(EPOCH FROM expires_at-NOW())*1000)::int AS "expiresInMs"`;

/** A scan session row as stored, locked for assigning its card. */
export interface EnrollmentRow {
  id: string;
  reader_id: string;
  user_id: number | null;
  actor_id: number;
  purpose: string;
  uid_hash: string;
  uid_last4: string;
  captured_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date;
}

/** Card scan sessions for staff card assignment and look-up. */
export class CardEnrollmentRepository {
  constructor(private db: Database) {}
  /** Locks the member a scan is for (row count). */
  async lockMember(userId: number) {
    return (
      await this.db.query('SELECT 1 FROM "user" WHERE userid=$1 FOR SHARE', [
        userId,
      ])
    ).rowCount;
  }
  async expireStale(readerId: string) {
    await this.db.query(
      `UPDATE app_card_enrollment SET cancelled_at=NOW() WHERE reader_id=$1 AND expires_at<=NOW()
        AND completed_at IS NULL AND cancelled_at IS NULL`,
      [readerId],
    );
  }
  /** Scans still open on this reader (row count). */
  async openOnReader(readerId: string) {
    return (
      await this.db.query(
        "SELECT id FROM app_card_enrollment WHERE reader_id=$1 AND completed_at IS NULL AND cancelled_at IS NULL",
        [readerId],
      )
    ).rowCount;
  }
  async create(
    id: string,
    readerId: string,
    userId: number | null,
    actorId: number,
    purpose: string,
  ) {
    return (
      await this.db.query(
        `INSERT INTO app_card_enrollment(id,reader_id,user_id,actor_id,purpose)
        VALUES($1,$2,$3,$4,$5) RETURNING id,reader_id AS "readerId",user_id AS "userId",purpose,expires_at AS "expiresAt",
        ${expiresInMs},'waiting' AS status`,
        [id, readerId, userId, actorId, purpose],
      )
    ).rows[0];
  }
  /** A scan as its starter sees it, with the captured card's fingerprint for the look-up. */
  async session(id: string, actorId: number) {
    return (
      await this.db.query(
        `SELECT id,reader_id AS "readerId",user_id AS "userId",purpose,uid_last4 AS "last4",uid_hash,
      expires_at AS "expiresAt",${expiresInMs},CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN completed_at IS NOT NULL AND purpose='assign' THEN 'completed'
      WHEN expires_at<=NOW() THEN 'expired' WHEN captured_at IS NOT NULL THEN 'captured' ELSE 'waiting' END AS status
      FROM app_card_enrollment WHERE id=$1 AND actor_id=$2`,
        [id, actorId],
      )
    ).rows[0];
  }
  /** Cancels the starter's unfinished scan (row count). */
  async cancel(id: string, actorId: number) {
    return (
      await this.db.query(
        `UPDATE app_card_enrollment SET cancelled_at=COALESCE(cancelled_at,NOW())
      WHERE id=$1 AND actor_id=$2 AND completed_at IS NULL RETURNING id`,
        [id, actorId],
      )
    ).rowCount;
  }
  async cancelOnReader(readerId: string) {
    await this.db.query(
      "UPDATE app_card_enrollment SET cancelled_at=NOW() WHERE reader_id=$1 AND completed_at IS NULL AND cancelled_at IS NULL",
      [readerId],
    );
  }
  async lockForAssignment(id: string, actorId: number) {
    return (
      await this.db.query<EnrollmentRow>(
        `SELECT * FROM app_card_enrollment WHERE id=$1 AND actor_id=$2 FOR UPDATE`,
        [id, actorId],
      )
    ).rows[0];
  }
  async complete(id: string) {
    await this.db.query(
      "UPDATE app_card_enrollment SET completed_at=NOW() WHERE id=$1",
      [id],
    );
  }
}
