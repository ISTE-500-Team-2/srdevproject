import { auditContext } from "../../auditContext.js";
import type { Database } from "../../db.js";

export interface AuditFilters {
  userId?: number | null;
  subjectId?: number | null;
  actorId?: number | null;
  action?: string | null;
  from?: string | null;
  to?: string | null;
}
/** One staff audit entry, joined with reader decisions where it records one. */
export interface AuditEntry {
  id: string;
  actorId: number | null;
  actorName: string;
  subjectId: number | null;
  action: string;
  entityType: string;
  entityId: number;
  createdAt: Date;
  subjectName: string | null;
  allowed: boolean | null;
  accessReason: string | null;
  readerId: string | null;
  resourceName: string | null;
}

/** The append-only staff audit trail (app_staff_audit). */
export class AuditRepository {
  constructor(private db: Database) {}
  async audit(
    actor: number | null,
    subject: number | null,
    action: string,
    type: string,
    id: number,
    reason: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    // Member flows record the member as actor; when staff have the member's
    // account open, the change was made by the staff member.
    const context = auditContext.getStore();
    if (context?.actingForId != null && actor === context.actingForId)
      actor = context.actorId ?? actor;
    await this.db.query(
      `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        actor,
        subject,
        action,
        type,
        id,
        reason,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
      ],
    );
  }
  async auditActions(): Promise<string[]> {
    const result = await this.db.query<{ action: string }>(
      "SELECT DISTINCT action FROM app_staff_audit ORDER BY action",
    );
    return result.rows.map((row) => row.action);
  }
  async audits(filters: AuditFilters, offset = 0): Promise<AuditEntry[]> {
    return (
      await this.db.query<AuditEntry>(
        `SELECT a.id::text,a.actor_id AS "actorId",COALESCE(u.firstname || ' ' || u.lastname,'System') AS "actorName",a.subject_id AS "subjectId",a.action,
      a.entity_type AS "entityType",a.entity_id AS "entityId",a.created_at AS "createdAt",
      trim(s.firstname || ' ' || s.lastname) AS "subjectName",
      e.allowed,e.reason AS "accessReason",e.reader_id AS "readerId",q.name AS "resourceName"
      FROM app_staff_audit a LEFT JOIN "user" u ON a.actor_id=u.userid
      LEFT JOIN "user" s ON s.userid=a.subject_id
      LEFT JOIN app_device_access_event e ON a.entity_type='app_device_access_event' AND e.id=a.entity_id
      LEFT JOIN equipment q ON e.target_kind='equipment' AND q.equipmentid=e.target_id
      WHERE ($1::int IS NULL OR a.actor_id=$1 OR a.subject_id=$1)
        AND ($2::int IS NULL OR a.subject_id=$2)
        AND ($3::text IS NULL OR a.action=$3)
        AND ($4::timestamptz IS NULL OR a.created_at >= $4)
        AND ($5::timestamptz IS NULL OR a.created_at <= $5)
        AND ($6::int IS NULL OR a.actor_id=$6)
      ORDER BY a.created_at DESC,a.id DESC LIMIT 51 OFFSET $7`,
        [
          filters.userId ?? null,
          filters.subjectId ?? null,
          filters.action ?? null,
          filters.from ?? null,
          filters.to ?? null,
          filters.actorId ?? null,
          offset,
        ],
      )
    ).rows;
  }
}
