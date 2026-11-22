// Staff-managed access reader rows (app_access_reader); credential encryption and resource
// targeting stay in the reader registry.

import type { Database } from "../../db.js";

/** A reader as staff see it: never its secret. */
export interface ReaderRecord {
  id: string;
  name: string;
  kind: string;
  resourceId: number;
  enabled: boolean;
  revision: number;
}

/** Reader configuration and the reader-level checks before a card scan starts. */
export class AccessReaderRepository {
  constructor(private db: Database) {}
  async createReader(
    id: string,
    name: string,
    kind: unknown,
    resourceId: number,
    secretEncrypted: string,
  ): Promise<ReaderRecord> {
    return (
      await this.db.query<ReaderRecord>(
        `INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted)
          VALUES($1,$2,$3,$4,$5) RETURNING id,name,kind,resource_id AS "resourceId",enabled,revision`,
        [id, name, kind, resourceId, secretEncrypted],
      )
    ).rows[0]!;
  }
  async lockReader(id: unknown): Promise<ReaderRecord | undefined> {
    return (
      await this.db.query<ReaderRecord>(
        `SELECT id,name,kind,resource_id AS "resourceId",enabled,revision FROM app_access_reader WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  /** Setup jobs on this reader that have not finished (row count). */
  async unfinishedSetups(readerId: string) {
    return (
      await this.db.query(
        "SELECT 1 FROM app_reader_setup_job WHERE reader_id=$1 AND status<>'complete'",
        [readerId],
      )
    ).rowCount;
  }
  async updateReader(
    id: string,
    name: string,
    enabled: boolean,
    kind: unknown,
    resourceId: number | null,
  ): Promise<ReaderRecord> {
    return (
      await this.db.query<ReaderRecord>(
        `UPDATE app_access_reader SET name=$2,enabled=$3,kind=COALESCE($4,kind),resource_id=COALESCE($5,resource_id),
            revision=revision+1 WHERE id=$1 RETURNING id,name,kind,resource_id AS "resourceId",enabled,revision`,
        [id, name, enabled, kind, resourceId],
      )
    ).rows[0]!;
  }
  async lockForScan(id: string) {
    return (
      await this.db.query<{ id: string; enabled: boolean }>(
        "SELECT id,enabled FROM app_access_reader WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
  }
  /**
   * A grant on this reader decided in the last 10 seconds that has not expired (row count).
   * Readers renew once a second with leases of at most 5 seconds, so such a grant means
   * someone is using it now.
   */
  async recentGrants(readerId: string) {
    return (
      await this.db.query(
        `SELECT 1 FROM app_device_access_event WHERE reader_id=$1 AND allowed
              AND created_at>NOW()-INTERVAL '10 seconds' AND expires_at>NOW() LIMIT 1`,
        [readerId],
      )
    ).rowCount;
  }
}
