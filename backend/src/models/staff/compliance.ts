import type { Database } from "../../db.js";

export interface ComplianceFilters {
  waiverId: number | null;
  certificationId: number | null;
  expiresWithinDays: number | null;
  userStatus: string;
  offset: number;
  /** Only members with something missing, expired or expiring soon. */
  attention?: boolean;
}
export const COMPLIANCE_EXPORT_LIMIT = 10000;

export interface ComplianceOptions {
  waivers: { id: number; name: string; version: string }[];
  certifications: { id: number; name: string }[];
}
/** One outstanding waiver/training requirement; timestamps arrive as JSON strings. */
export interface ComplianceIssue {
  kind: "waiver" | "certification";
  name: string;
  state: "missing" | "expired" | "expiring";
  expiresAt: string | null;
}
export interface ComplianceUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  // Nullable in the legacy schema; every application write sets it.
  status: string;
  accessStatus: string;
  waiverCompliant: boolean;
  certificationCompliant: boolean;
  missingWaivers: string[];
  expiringWaivers: string[];
  missingCertifications: string[];
  expiringCertifications: string[];
  issues: ComplianceIssue[];
}
export interface ComplianceCounts {
  userCount: number;
  compliantUsers: number;
  waiverCompliantUsers: number;
  certificationCompliantUsers: number;
  attentionUsers: number;
}
export interface RequirementBreakdown {
  id: number;
  name: string;
  total: number;
  compliant: number;
  expiring: number;
}
export interface ComplianceReport {
  summary: ComplianceCounts & {
    complianceRate: number;
    waiverComplianceRate: number;
    certificationComplianceRate: number;
  };
  users: ComplianceUser[];
  waiverBreakdown: (RequirementBreakdown & { version: string })[];
  certificationBreakdown: RequirementBreakdown[];
  nextOffset: number | null;
  filteredCount: number;
}
interface ComplianceRow {
  summary: ComplianceCounts | null;
  users: ComplianceUser[];
  waiverBreakdown: ComplianceReport["waiverBreakdown"];
  certificationBreakdown: ComplianceReport["certificationBreakdown"];
  filteredCount: number;
}

/** Waiver and training compliance reporting across members. */
export class ComplianceReports {
  constructor(private db: Database) {}
  async complianceOptions(): Promise<ComplianceOptions> {
    const [waivers, certifications] = await Promise.all([
      this.db.query<ComplianceOptions["waivers"][number]>(
        `WITH current_waivers AS (
          SELECT DISTINCT ON (name) waiverid AS id,name,version
          FROM waiver
          WHERE isactive=true AND required=true
            AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
        )
        SELECT id,name,version FROM current_waivers ORDER BY name`,
      ),
      this.db.query<ComplianceOptions["certifications"][number]>(
        `SELECT certid AS id,name FROM certifications
        WHERE (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
        ORDER BY name,certid`,
      ),
    ]);
    return { waivers: waivers.rows, certifications: certifications.rows };
  }
  async compliance(filters: ComplianceFilters, includeAllRows = false): Promise<ComplianceReport> {
    const limit = includeAllRows ? COMPLIANCE_EXPORT_LIMIT : 51;
    const params = [
      filters.waiverId,
      filters.certificationId,
      filters.expiresWithinDays,
      filters.userStatus,
      filters.offset,
      limit,
      filters.attention ?? false,
    ];
    const query = `
      WITH report_users AS (
        SELECT u.userid,u.firstname,u.lastname,u.email,u.status,u.accessstatus
        FROM "user" u
        WHERE ($4::text='all' OR u.status=$4::text)
      ),
      current_waivers AS (
        SELECT DISTINCT ON (name) waiverid,name,version
        FROM waiver
        WHERE isactive=true AND required=true
          AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          AND ($1::int IS NULL OR waiverid=$1)
        ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
      ),
      report_certifications AS (
        SELECT certid,name,enddate FROM certifications
        WHERE (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          AND ($2::int IS NULL OR certid=$2)
          AND ($2::int IS NOT NULL OR enddate IS NULL OR enddate>=NOW() AT TIME ZONE 'UTC')
      ),
      waiver_status AS (
        SELECT ru.userid,w.waiverid,w.name,w.version,sig.signdate,sig.expires_at,
          (sig.userwaiverid IS NOT NULL AND (sig.expires_at IS NULL OR sig.expires_at>NOW())) AS compliant,
          (sig.expires_at IS NOT NULL AND sig.expires_at<=NOW()) AS expired,
          (sig.expires_at IS NOT NULL AND $3::int IS NOT NULL
            AND (sig.expires_at<=NOW()+make_interval(days=>$3::int))) AS expiring
        FROM report_users ru CROSS JOIN current_waivers w
        LEFT JOIN LATERAL (
          SELECT userwaiverid,signdate,expires_at FROM user_waiver
          WHERE userid=ru.userid AND waiverid=w.waiverid AND approval=true
          ORDER BY signdate DESC,userwaiverid DESC LIMIT 1
        ) sig ON true
      ),
      certification_status AS (
        SELECT ru.userid,c.certid,c.name,uc.status,uc.renewaldate,c.enddate,
          CASE
            WHEN uc.renewaldate IS NULL THEN c.enddate
            WHEN c.enddate IS NULL THEN uc.renewaldate
            WHEN uc.renewaldate<=c.enddate THEN uc.renewaldate
            ELSE c.enddate
          END AS effective_expires_at,
          (uc.usercertid IS NOT NULL AND uc.status='active'
            AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')
            AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC')) AS compliant,
          (uc.usercertid IS NOT NULL
            AND ((uc.renewaldate IS NOT NULL AND uc.renewaldate<NOW() AT TIME ZONE 'UTC')
              OR (c.enddate IS NOT NULL AND c.enddate<NOW() AT TIME ZONE 'UTC'))) AS expired,
          (uc.usercertid IS NOT NULL AND $3::int IS NOT NULL
            AND (CASE
              WHEN uc.renewaldate IS NULL THEN c.enddate
              WHEN c.enddate IS NULL THEN uc.renewaldate
              WHEN uc.renewaldate<=c.enddate THEN uc.renewaldate
              ELSE c.enddate
            END)<=NOW() AT TIME ZONE 'UTC'+make_interval(days=>$3::int)) AS expiring
        FROM report_users ru CROSS JOIN report_certifications c
        LEFT JOIN LATERAL (
          SELECT usercertid,status,renewaldate FROM user_certifications
          WHERE userid=ru.userid AND certid=c.certid
          ORDER BY renewaldate DESC NULLS LAST,usercertid DESC LIMIT 1
        ) uc ON true
      ),
      -- Aggregate each user's waiver/training state once. Correlated scans of
      -- these materialized sets made the old rollup quadratic in member count.
      waiver_rollup AS (
        SELECT userid,
          bool_and(compliant) AS compliant,
          array_agg(name || ' ' || version ORDER BY name) FILTER (WHERE NOT compliant) AS missing,
          array_agg(name || ' ' || version ORDER BY name) FILTER (WHERE expiring) AS expiring,
          jsonb_agg(jsonb_build_object('kind','waiver','name',name,
            'state',CASE WHEN NOT compliant AND expired THEN 'expired' WHEN NOT compliant THEN 'missing' ELSE 'expiring' END,
            'expiresAt',expires_at) ORDER BY name)
            FILTER (WHERE NOT compliant OR (expires_at IS NOT NULL
              AND expires_at<=NOW()+make_interval(days=>COALESCE($3::int,30)))) AS issues
        FROM waiver_status GROUP BY userid
      ),
      certification_rollup AS (
        SELECT userid,
          bool_and(compliant) AS compliant,
          array_agg(name ORDER BY name) FILTER (WHERE NOT compliant) AS missing,
          array_agg(name ORDER BY name) FILTER (WHERE expiring) AS expiring,
          jsonb_agg(jsonb_build_object('kind','certification','name',name,
            'state',CASE WHEN NOT compliant AND expired THEN 'expired' WHEN NOT compliant THEN 'missing' ELSE 'expiring' END,
            'expiresAt',effective_expires_at AT TIME ZONE 'UTC') ORDER BY name)
            FILTER (WHERE NOT compliant OR (effective_expires_at IS NOT NULL
              AND effective_expires_at<=NOW() AT TIME ZONE 'UTC'+make_interval(days=>COALESCE($3::int,30)))) AS issues
        FROM certification_status GROUP BY userid
      ),
      user_rollup AS (
        SELECT ru.userid AS id,ru.firstname AS "firstName",ru.lastname AS "lastName",ru.email,ru.status,ru.accessstatus AS "accessStatus",
          COALESCE(wr.compliant,true) AS "waiverCompliant",
          COALESCE(cr.compliant,true) AS "certificationCompliant",
          COALESCE(wr.missing,'{}') AS "missingWaivers",
          COALESCE(wr.expiring,'{}') AS "expiringWaivers",
          COALESCE(cr.missing,'{}') AS "missingCertifications",
          COALESCE(cr.expiring,'{}') AS "expiringCertifications",
          COALESCE(wr.issues,'[]'::jsonb) || COALESCE(cr.issues,'[]'::jsonb) AS issues
        FROM report_users ru
        LEFT JOIN waiver_rollup wr USING(userid)
        LEFT JOIN certification_rollup cr USING(userid)
      ),
      window_users AS (
        SELECT * FROM user_rollup
        WHERE $3::int IS NULL OR array_length("expiringWaivers",1) IS NOT NULL OR array_length("expiringCertifications",1) IS NOT NULL
      ),
      -- "Needs attention" narrows only the member list; the summary and
      -- per-requirement breakdowns still describe everyone in the window.
      filtered_users AS (
        SELECT * FROM window_users
        WHERE NOT $7::boolean OR NOT ("waiverCompliant" AND "certificationCompliant") OR jsonb_array_length(issues)>0
      ),
      summary AS (
        SELECT COUNT(*)::int AS "userCount",
          COUNT(*) FILTER (WHERE "waiverCompliant" AND "certificationCompliant")::int AS "compliantUsers",
          COUNT(*) FILTER (WHERE "waiverCompliant")::int AS "waiverCompliantUsers",
          COUNT(*) FILTER (WHERE "certificationCompliant")::int AS "certificationCompliantUsers",
          COUNT(*) FILTER (WHERE NOT ("waiverCompliant" AND "certificationCompliant") OR jsonb_array_length(issues)>0)::int AS "attentionUsers"
        FROM window_users
      )
      SELECT
        (SELECT row_to_json(summary) FROM summary) AS summary,
        COALESCE((SELECT json_agg(row_to_json(paged) ORDER BY "lastName","firstName",id)
          FROM (SELECT * FROM filtered_users ORDER BY "lastName","firstName",id LIMIT $6 OFFSET $5) paged),'[]'::json) AS users,
        COALESCE((SELECT json_agg(row_to_json(w) ORDER BY name)
          FROM (SELECT waiverid AS id,name,version,COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE compliant)::int AS compliant,
            COUNT(*) FILTER (WHERE expiring)::int AS expiring
            FROM waiver_status ws JOIN window_users fu ON fu.id=ws.userid GROUP BY waiverid,name,version) w),'[]'::json) AS "waiverBreakdown",
        COALESCE((SELECT json_agg(row_to_json(c) ORDER BY name)
          FROM (SELECT certid AS id,name,COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE compliant)::int AS compliant,
            COUNT(*) FILTER (WHERE expiring)::int AS expiring
            FROM certification_status cs JOIN window_users fu ON fu.id=cs.userid GROUP BY certid,name) c),'[]'::json) AS "certificationBreakdown",
        (SELECT COUNT(*)::int FROM filtered_users) AS "filteredCount"`;
    const row = (await this.db.query<ComplianceRow>(query, params)).rows[0]!;
    const summary = row.summary ?? {
      userCount: 0,
      compliantUsers: 0,
      waiverCompliantUsers: 0,
      certificationCompliantUsers: 0,
      attentionUsers: 0,
    };
    return {
      summary: {
        ...summary,
        complianceRate: summary.userCount ? summary.compliantUsers / summary.userCount : 1,
        waiverComplianceRate: summary.userCount ? summary.waiverCompliantUsers / summary.userCount : 1,
        certificationComplianceRate: summary.userCount ? summary.certificationCompliantUsers / summary.userCount : 1,
      },
      users: row.users,
      waiverBreakdown: row.waiverBreakdown,
      certificationBreakdown: row.certificationBreakdown,
      nextOffset: !includeAllRows && row.users.length > 50 ? filters.offset + 50 : null,
      filteredCount: row.filteredCount,
    };
  }
}
