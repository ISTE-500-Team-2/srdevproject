import type { Database } from "../../db.js";

/** A remembered staff issuance request, replayed when the same request ID is retried. */
export interface IssuanceRequest {
  actorId: number;
  fingerprint: string;
  result: Record<string, unknown>;
}

/** Idempotency records for staff access issuance (app_issuance_request). */
export class IssuanceRequestRepository {
  constructor(private db: Database) {}
  async request(id: string): Promise<IssuanceRequest | undefined> {
    return (
      await this.db.query<IssuanceRequest>(
        'SELECT actor_id AS "actorId",fingerprint,result FROM app_issuance_request WHERE request_id=$1',
        [id],
      )
    ).rows[0];
  }
  async saveRequest(
    id: string,
    actorId: number,
    fingerprint: string,
    result: unknown,
  ): Promise<void> {
    await this.db.query(
      "INSERT INTO app_issuance_request(request_id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4)",
      [id, actorId, fingerprint, JSON.stringify(result)],
    );
  }
}
