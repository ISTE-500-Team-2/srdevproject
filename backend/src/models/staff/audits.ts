import { auditContext } from "../../auditContext.js";
import type { Database } from "../../db.js";

/** Staff actions, card taps, or database writes: what the change log can show. */
export type AuditView = "staff" | "taps" | "database";
export const AUDIT_VIEWS_LIST = ["staff", "taps", "database"] as const satisfies readonly AuditView[];
export interface AuditFilters {
  userId?: number | null;
  subjectId?: number | null;
  actorId?: number | null;
  action?: string | null;
  actions?: string[] | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  view?: AuditView | null;
  /**
   * Only what the member record shows: actions people took, card taps and reader check-ins. The
   * database's other row copies (sign-ins, queued email, visits, bookings…) never show there, and
   * for an active member they would otherwise fill the whole page and hide every real change.
   */
  recordActivity?: boolean | null;
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
  /** The name of the thing the record is about: equipment, room, plan, waiver, class… */
  resourceName: string | null;
}
export type AuditSource = "application" | "database";
/** One entry with its reason and stored states, for the record's detail view. */
export interface AuditRecordRow extends AuditEntry {
  reason: string;
  source: AuditSource;
  before: unknown;
  after: unknown;
}
/** Another row saved in the same transaction as a record. */
export interface RelatedAuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: number;
  source: AuditSource;
}
export interface AuditRecordDetail {
  record: AuditRecordRow;
  related: RelatedAuditRow[];
  relatedCount: number;
}

// Sign-in bookkeeping: hundreds of rows a day, none of them a change anyone made.
const HOUSEKEEPING = `('app_session','app_refresh_token','app_refresh_family')`;
/**
 * Staff actions are the rows the application records itself, with a reason and the
 * before/after states. Card taps are reader events. Database writes are what the
 * row triggers captured, minus sign-in bookkeeping.
 */
const AUDIT_VIEWS: Record<AuditView, string> = {
  staff: `a.source='application'`,
  taps: `(a.entity_type='app_device_access_event' AND a.action='app_device_access_event.insert')`,
  database: `(a.source='database' AND a.entity_type<>'app_device_access_event' AND a.entity_type NOT IN ${HOUSEKEEPING})`,
};
// The name of the thing a record is about, so a row can say "CNC router" rather than "equipment #4".
// Entity types are an action's own ("plan") or, for trigger rows, the table name ("membership_tiers").
const AUDIT_FROM = `FROM app_staff_audit a LEFT JOIN "user" u ON a.actor_id=u.userid
      LEFT JOIN "user" s ON s.userid=a.subject_id
      LEFT JOIN app_device_access_event e ON a.entity_type='app_device_access_event' AND e.id=a.entity_id
      LEFT JOIN LATERAL (SELECT CASE
        WHEN a.entity_type='app_device_access_event' THEN
          (SELECT name FROM equipment WHERE e.target_kind='equipment' AND equipmentid=e.target_id)
        WHEN a.entity_type='equipment' THEN (SELECT name FROM equipment WHERE equipmentid=a.entity_id)
        WHEN a.entity_type='reservation' THEN (SELECT COALESCE(q.name,m.name) FROM reservation r
          LEFT JOIN equipment q ON q.equipmentid=r.equipmentid LEFT JOIN room m ON m.roomid=r.roomid
          WHERE r.reservationid=a.entity_id)
        WHEN a.entity_type IN ('plan','membership_tiers') THEN (SELECT tiername FROM membership_tiers WHERE tierid=a.entity_id)
        WHEN a.entity_type='waiver' THEN (SELECT name FROM waiver WHERE waiverid=a.entity_id)
        WHEN a.entity_type IN ('certification','certifications') THEN (SELECT name FROM certifications WHERE certid=a.entity_id)
        WHEN a.entity_type IN ('training_class','app_training_class') THEN (SELECT title FROM app_training_class WHERE id=a.entity_id)
        WHEN a.entity_type='app_service_notice' THEN (SELECT summary FROM app_service_notice WHERE id=a.entity_id)
        WHEN a.entity_type='app_studio' THEN (SELECT name FROM app_studio WHERE id=a.entity_id)
        WHEN a.entity_type='room' THEN (SELECT name FROM room WHERE roomid=a.entity_id)
      END AS name) named ON true`;
const AUDIT_COLUMNS = `a.id::text,a.actor_id AS "actorId",COALESCE(u.firstname || ' ' || u.lastname,'System') AS "actorName",a.subject_id AS "subjectId",a.action,
      a.entity_type AS "entityType",a.entity_id AS "entityId",a.created_at AS "createdAt",
      trim(s.firstname || ' ' || s.lastname) AS "subjectName",
      e.allowed,e.reason AS "accessReason",e.reader_id AS "readerId",named.name AS "resourceName"`;
// $8 is a LIKE pattern: auditParams escapes the search text.
const AUDIT_WHERE = `WHERE ($1::int IS NULL OR a.actor_id=$1 OR a.subject_id=$1)
        AND ($2::int IS NULL OR a.subject_id=$2)
        AND ($3::text IS NULL OR a.action=$3)
        AND ($4::timestamptz IS NULL OR a.created_at >= $4)
        AND ($5::timestamptz IS NULL OR a.created_at <= $5)
        AND ($6::int IS NULL OR a.actor_id=$6)
        AND ($7::text[] IS NULL OR a.action=ANY($7))
        AND ($8::text IS NULL OR concat_ws(' ',u.firstname,u.lastname,s.firstname,s.lastname,s.email,named.name,
          translate(a.action,'._','  ')) ILIKE $8 ESCAPE '\\')`;
function auditParams(filters: AuditFilters) {
  const search = filters.search?.trim();
  return [
    filters.userId ?? null,
    filters.subjectId ?? null,
    filters.action ?? null,
    filters.from ?? null,
    filters.to ?? null,
    filters.actorId ?? null,
    filters.actions ?? null,
    search ? `%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null,
  ];
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
  /** Without a view, every row matches (the member record and older callers rely on that). */
  async audits(filters: AuditFilters, offset = 0): Promise<AuditEntry[]> {
    return (
      await this.db.query<AuditEntry>(
        `SELECT ${AUDIT_COLUMNS} ${AUDIT_FROM} ${AUDIT_WHERE}
        AND ($9::text IS NULL OR ($9='staff' AND ${AUDIT_VIEWS.staff})
          OR ($9='taps' AND ${AUDIT_VIEWS.taps}) OR ($9='database' AND ${AUDIT_VIEWS.database}))
        AND (NOT $11::boolean OR ${AUDIT_VIEWS.staff} OR a.entity_type IN ('app_device_access_event','check_in'))
      ORDER BY a.created_at DESC,a.id DESC LIMIT 51 OFFSET $10`,
        [...auditParams(filters), filters.view ?? null, offset, filters.recordActivity ?? false],
      )
    ).rows;
  }
  /** How many rows each view holds under the same filters, for the view switcher and page totals. */
  async auditCounts(filters: AuditFilters): Promise<Record<AuditView, number>> {
    return (
      await this.db.query<Record<AuditView, number>>(
        `SELECT COUNT(*) FILTER (WHERE ${AUDIT_VIEWS.staff})::int AS staff,
          COUNT(*) FILTER (WHERE ${AUDIT_VIEWS.taps})::int AS taps,
          COUNT(*) FILTER (WHERE ${AUDIT_VIEWS.database})::int AS database
        ${AUDIT_FROM} ${AUDIT_WHERE}
        -- No view counts sign-in bookkeeping, so skip it before searching anything.
        AND a.entity_type NOT IN ${HOUSEKEEPING}`,
        auditParams(filters),
      )
    ).rows[0] ?? { staff: 0, taps: 0, database: 0 };
  }
  /**
   * One record with its reason and stored states, plus the other rows written in the
   * same transaction: an action's database-trigger copies, or the action behind a copy.
   * Rows in one transaction share created_at exactly (NOW() is the transaction's start).
   */
  async auditRecord(id: number): Promise<AuditRecordDetail | null> {
    const record = (
      await this.db.query<AuditRecordRow>(
        `SELECT ${AUDIT_COLUMNS},a.reason,a.source,a.before_state AS "before",a.after_state AS "after"
        ${AUDIT_FROM} WHERE a.id=$1`,
        [id],
      )
    ).rows[0];
    if (!record) return null;
    const related = await this.db.query<RelatedAuditRow & { total: number }>(
      `WITH this AS (SELECT created_at,actor_id FROM app_staff_audit WHERE id=$1)
      SELECT a.id::text,a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.source,
        COUNT(*) OVER()::int AS total
      FROM app_staff_audit a,this
      WHERE a.created_at=this.created_at AND a.actor_id IS NOT DISTINCT FROM this.actor_id AND a.id<>$1
        AND a.entity_type NOT IN ${HOUSEKEEPING}
      ORDER BY (a.source='application') DESC,a.id LIMIT 25`,
      [id],
    );
    return {
      record,
      related: related.rows.map(({ total: _total, ...row }) => row),
      relatedCount: related.rows[0]?.total ?? 0,
    };
  }
}
