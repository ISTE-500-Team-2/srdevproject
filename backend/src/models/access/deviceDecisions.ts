// Rows a signed reader request reads and writes while its access decision is made: the reader,
// an open card scan, the tapped card, the recorded decision and an NFC check-in.

import type { Database } from "../../db.js";
import { readerColumns, type StoredReader } from "../../readerRegistry.js";

/** Reader request queries; each runs on the decision's transaction client. */
export class DeviceDecisionRepository {
  constructor(private db: Database) {}
  /**
   * The reader with its encrypted secret. Taps share the row, while disable/enrollment/credential
   * changes retain exclusive locks.
   */
  async lockReader(readerId: string, lock: "FOR UPDATE" | "FOR SHARE") {
    return (
      await this.db.query<StoredReader>(
        `SELECT ${readerColumns} FROM app_access_reader WHERE id=$1 ${lock}`,
        [readerId],
      )
    ).rows[0];
  }
  async lockOpenEnrollment(readerId: string) {
    return (
      await this.db.query<{ id: string; purpose: string; captured_at: Date | null; expires_at: Date }>(
        `SELECT id,purpose,captured_at,expires_at FROM app_card_enrollment
        WHERE reader_id=$1 AND cancelled_at IS NULL AND completed_at IS NULL AND expires_at>NOW() FOR UPDATE`,
        [readerId],
      )
    ).rows[0];
  }
  async markSeen(readerId: string) {
    await this.db.query('UPDATE app_access_reader SET last_seen_at=NOW() WHERE id=$1', [readerId]);
  }
  /** Decisions already recorded for this event ID (row count). */
  async recordedEvents(readerId: string, eventId: string) {
    return (
      await this.db.query(
        "SELECT id FROM app_device_access_event WHERE reader_id=$1 AND request_id=$2",
        [readerId, eventId],
      )
    ).rowCount;
  }
  async lockCard(hash: string) {
    return (
      await this.db.query<{ id: number; user_id: number; active: boolean }>(
        "SELECT id,user_id,active FROM app_access_card WHERE uid_hash=$1 ORDER BY active DESC,id DESC LIMIT 1 FOR SHARE",
        [hash],
      )
    ).rows[0];
  }
  async captureEnrollment(id: string, hash: string, last4: string) {
    await this.db.query(
      `UPDATE app_card_enrollment SET uid_hash=$2,uid_last4=$3,captured_at=NOW(),
            completed_at=CASE WHEN purpose='lookup' THEN NOW() ELSE NULL END WHERE id=$1`,
      [id, hash, last4],
    );
  }
  /** The recorded decision's ID, or nothing when a simultaneous duplicate won the unique index. */
  async recordDecision(
    readerId: string,
    requestId: string,
    userId: number | null,
    targetKind: string,
    targetId: number,
    allowed: boolean,
    reason: string,
    expiresAt: unknown,
    hash: string,
    last4: string,
    cardId: number | null,
    isTap: boolean,
  ) {
    return (
      await this.db.query<{ id: number }>(
        `INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at,uid_hash,uid_last4,card_id,is_tap)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(reader_id,request_id) DO NOTHING RETURNING id`,
        [
          readerId,
          requestId,
          userId,
          targetKind,
          targetId,
          allowed,
          reason,
          expiresAt,
          hash,
          last4,
          cardId,
          isTap,
        ],
      )
    ).rows[0];
  }
  async recordCheckIn(
    userId: number,
    roomId: number | null,
    location: unknown,
    buildingId: unknown,
    equipmentId: number | null,
    reservationId: unknown,
  ) {
    await this.db.query(
      `INSERT INTO check_in(userid,roomid,location,buildingid,equipmentid,reservationid,checkintime,status,statusdesc,origin)
          VALUES($1,$2,$3,$4,$5,$6,NOW() AT TIME ZONE 'UTC','approved','Authenticated NFC eligibility decision','nfc')`,
      [userId, roomId, location, buildingId, equipmentId, reservationId],
    );
  }
}
