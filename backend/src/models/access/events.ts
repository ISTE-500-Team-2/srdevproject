// Recorded card taps (app_device_access_event) for the staff activity list.

import type { Database } from "../../db.js";

export type TapResult = "allowed" | "denied" | "unknown" | "all";
/** Validated filters; an absent one matches every tap. */
export interface TapFilters {
  readerId?: string;
  userId?: number;
  before?: number;
  result?: TapResult;
}

/** Card taps, newest first, a page at a time. */
export class AccessEventRepository {
  constructor(private db: Database) {}
  /** Up to 51 taps, one more than a page, so the caller can tell whether more follow. */
  async taps(filter: TapFilters) {
    const values: unknown[] = [],
      filters = ["e.is_tap"];
    if (filter.readerId !== undefined) {
      values.push(filter.readerId);
      filters.push(`e.reader_id=$${values.length}`);
    }
    if (filter.userId !== undefined) {
      values.push(filter.userId);
      filters.push(`e.user_id=$${values.length}`);
    }
    if (filter.before !== undefined) {
      values.push(filter.before);
      filters.push(`e.id<$${values.length}`);
    }
    const result = filter.result;
    if (result === "allowed") filters.push("e.allowed");
    else if (result === "denied") filters.push("NOT e.allowed");
    else if (result === "unknown")
      filters.push("e.card_id IS NULL AND e.uid_hash IS NOT NULL");
    return (
      await this.db.query(
        `SELECT e.id,e.reader_id AS "readerId",COALESCE(r.name,e.reader_id) AS "readerName",
      e.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",e.uid_last4 AS "last4",e.allowed,e.reason,
      (SELECT p.version FROM app_user_photo p WHERE p.user_id=e.user_id) AS "photoVersion",
      e.created_at AS "createdAt" FROM app_device_access_event e LEFT JOIN app_access_reader r ON r.id=e.reader_id
      LEFT JOIN "user" u ON u.userid=e.user_id WHERE ${filters.join(" AND ")} ORDER BY e.id DESC LIMIT 51`,
        values,
      )
    ).rows;
  }
}
