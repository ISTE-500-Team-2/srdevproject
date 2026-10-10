import type { Database } from "../db.js";
import type { PlanInput } from "../staffDomain.js";

export interface Plan extends PlanInput {
  id: number;
  revision: number;
}
export interface ComplianceFilters {
  waiverId: number | null;
  certificationId: number | null;
  expiresWithinDays: number | null;
  userStatus: string;
  offset: number;
}
const planColumns =
  "tierid AS id,tiername AS name,kind,tierprice::text AS price,allottedmonths AS months,benefits,active,revision";
const personColumns = `u.userid AS id,u.firstname AS "firstName",u.lastname AS "lastName",u.email,u.phone,u.status,
  u.primary_role AS "primaryRole",u.is_student AS "isStudent",u.accessstatus AS "accessStatus",u.accessreason AS "accessReason",u.revision,
  COALESCE(u.conductflag,false) AS "conductFlag",
  u.profile_address AS address,u.contact_preferences AS "contactPreferences",
  COALESCE((SELECT json_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid),'[]') AS roles`;

export class StaffModel {
  constructor(
    private db: Database,
    private timeZone = "America/New_York",
  ) {}
  async plans(activeOnly = false) {
    return (
      await this.db.query<Plan>(
        `SELECT ${planColumns} FROM membership_tiers ${activeOnly ? "WHERE active=true" : ""} ORDER BY kind,tiername,tierid`,
      )
    ).rows;
  }
  async plan(id: number, lock = false) {
    return (
      await this.db.query<Plan>(
        `SELECT ${planColumns} FROM membership_tiers WHERE tierid=$1 ${lock ? "FOR SHARE" : ""}`,
        [id],
      )
    ).rows[0];
  }
  async createPlan(input: PlanInput) {
    return (
      await this.db.query<Plan>(
        `INSERT INTO membership_tiers(tiername,kind,tierprice,allottedmonths,benefits,active)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING ${planColumns}`,
        [
          input.name,
          input.kind,
          input.price,
          input.months,
          input.benefits,
          input.active,
        ],
      )
    ).rows[0]!;
  }
  async updatePlan(id: number, input: PlanInput, revision: number) {
    return (
      await this.db.query<Plan>(
        `UPDATE membership_tiers SET tiername=$2,tierprice=$3,allottedmonths=$4,benefits=$5,active=$6,revision=revision+1
      WHERE tierid=$1 AND revision=$7 RETURNING ${planColumns}`,
        [
          id,
          input.name,
          input.price,
          input.months,
          input.benefits,
          input.active,
          revision,
        ],
      )
    ).rows[0];
  }
  async users(search: string, offset: number) {
    return (
      await this.db.query(
        `SELECT ${personColumns} FROM "user" u WHERE
      (u.firstname || ' ' || u.lastname || ' ' || u.email) ILIKE $1 ORDER BY u.lastname,u.firstname,u.userid LIMIT 51 OFFSET $2`,
        ["%" + search + "%", offset],
      )
    ).rows;
  }
  async person(id: number, lock = false) {
    return (
      await this.db.query(
        `SELECT ${personColumns} FROM "user" u WHERE userid=$1 ${lock ? "FOR UPDATE OF u" : ""}`,
        [id],
      )
    ).rows[0];
  }
  async updatePerson(
    id: number,
    firstName: string,
    lastName: string,
    phone: string,
    revision: number,
  ) {
    const result = await this.db.query(
      `UPDATE "user" SET firstname=$2,lastname=$3,phone=$4,revision=revision+1 WHERE userid=$1 AND revision=$5 RETURNING userid`,
      [id, firstName, lastName, phone, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async access(id: number, status: string, reason: string, revision: number) {
    const result = await this.db.query(
      `UPDATE "user" SET accessstatus=$2,accessreason=$3,revision=revision+1 WHERE userid=$1 AND revision=$4 RETURNING userid`,
      [id, status, reason, revision],
    );
    return result.rowCount ? this.person(id) : undefined;
  }
  async setRole(id: number, role: string, roles?: string[], isStudent?: boolean) {
    if (roles) {
      // Explicit multi-role editor replaces managed roles only; retain unknown legacy classifications.
      await this.db.query(`DELETE FROM user_role WHERE userid=$1 AND roleid IN
        (SELECT roleid FROM role WHERE role IN ('member','admin','staff','subscriber','day_pass','instructor','student'))`,[id]);
    }
    await this.db.query(`INSERT INTO user_role(userid,roleid,assignedat)
      SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role=ANY($2::text[])
      AND NOT EXISTS(SELECT 1 FROM user_role ur WHERE ur.userid=$1 AND ur.roleid=role.roleid)`,[id,roles ?? [role]]);
    await this.db.query('UPDATE "user" SET primary_role=$2,is_student=COALESCE($3,is_student),revision=revision+1 WHERE userid=$1',[id,role,isStudent ?? null]);
    return this.person(id);
  }
  async roleExists(role: string) {
    return (
      (await this.db.query("SELECT roleid FROM role WHERE role=$1", [role]))
        .rows.length === 1
    );
  }
  async activeAdmins() {
    return Number(
      (
        await this.db.query(
          `SELECT COUNT(DISTINCT u.userid) AS count FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid) WHERE u.status='active' AND r.role='admin'`,
        )
      ).rows[0]!.count,
    );
  }
  async memberships(userId: number) {
    return (
      await this.db.query(
        `SELECT m.membershipid AS id,m.userid AS "userId",m.tierid AS "planId",m.status,m.statusdesc AS reason,m.revision,
      m.startdate AT TIME ZONE 'UTC' AS "startsAt",m.end_date AT TIME ZONE 'UTC' AS "endsAt",
      COALESCE(m.plan_snapshot,jsonb_build_object('name',t.tiername,'price',t.tierprice::text,'benefits',t.benefits)) AS plan,
      CASE WHEN m.status<>'active' THEN m.status WHEN m.end_date<=NOW() AT TIME ZONE 'UTC' THEN 'expired'
        WHEN m.startdate>NOW() AT TIME ZONE 'UTC' THEN 'scheduled' ELSE 'active' END AS "effectiveStatus"
      FROM user_membership m LEFT JOIN membership_tiers t USING(tierid) WHERE m.userid=$1 ORDER BY m.startdate DESC,m.membershipid DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  async passes(userId: number) {
    return (
      await this.db.query(
        `SELECT d.dayid AS id,d.userid AS "userId",d.tierid AS "planId",d.status,d.statusdesc AS reason,d.revision,
      to_char(d.validdate,'YYYY-MM-DD') AS "validDate",d.paymentid AS "paymentId",d.plan_snapshot AS plan,
      CASE WHEN d.status<>'active' THEN d.status WHEN d.validdate::date<(NOW() AT TIME ZONE $2)::date THEN 'expired'
        WHEN d.validdate::date>(NOW() AT TIME ZONE $2)::date THEN 'scheduled' ELSE 'active' END AS "effectiveStatus"
      FROM day_pass d WHERE d.userid=$1 ORDER BY d.validdate DESC,d.dayid DESC LIMIT 100`,
        [userId, this.timeZone],
      )
    ).rows;
  }
  async entitlement(kind: "membership" | "day_pass", id: number) {
    const table = kind === "membership" ? "user_membership" : "day_pass";
    const key = kind === "membership" ? "membershipid" : "dayid";
    return (
      await this.db.query(
        `SELECT ${key} AS id,userid AS "userId",status,revision FROM ${table} WHERE ${key}=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  async membershipWindow(userId: number, startsAt: string, months: number) {
    return (
      await this.db.query(
        `WITH span AS (SELECT $2::timestamptz AT TIME ZONE 'UTC' AS a,
      ($2::timestamptz AT TIME ZONE 'UTC')+make_interval(months=>$3::int) AS b)
      SELECT b AT TIME ZONE 'UTC' AS "endsAt",EXISTS(SELECT 1 FROM user_membership,span WHERE userid=$1 AND status IN('active','suspended')
      AND startdate<span.b AND end_date>span.a) AS overlap FROM span`,
        [userId, startsAt, months],
      )
    ).rows[0]!;
  }
  async passExists(userId: number, date: string) {
    return (
      (
        await this.db.query(
          `SELECT dayid FROM day_pass WHERE userid=$1 AND validdate::date=$2::date AND status IN('active','suspended')`,
          [userId, date],
        )
      ).rows.length > 0
    );
  }
  async createMembership(
    userId: number,
    plan: Plan,
    startsAt: string,
    endsAt: Date,
    actorId: number,
    reason: string,
  ) {
    return (
      await this.db.query(
        `INSERT INTO user_membership(userid,tierid,startdate,end_date,status,statusdesc,plan_snapshot,issued_by)
      VALUES($1,$2,$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','active',$5,$6,$7)
      RETURNING membershipid AS id`,
        [
          userId,
          plan.id,
          startsAt,
          endsAt,
          reason,
          JSON.stringify(plan),
          actorId,
        ],
      )
    ).rows[0]!.id as number;
  }
  async createPass(
    userId: number,
    plan: Plan,
    date: string,
    actorId: number,
    reason: string,
  ) {
    return (
      await this.db.query(
        `INSERT INTO day_pass(userid,tierid,validdate,purchasedate,status,statusdesc,plan_snapshot,issued_by)
      VALUES($1,$2,$3::date,NOW() AT TIME ZONE 'UTC','active',$4,$5,$6) RETURNING dayid AS id`,
        [userId, plan.id, date, reason, JSON.stringify(plan), actorId],
      )
    ).rows[0]!.id as number;
  }
  async changeEntitlement(
    kind: "membership" | "day_pass",
    id: number,
    status: string,
    reason: string,
    revision: number,
  ) {
    const table = kind === "membership" ? "user_membership" : "day_pass";
    const key = kind === "membership" ? "membershipid" : "dayid";
    return (
      await this.db.query(
        `UPDATE ${table} SET status=$2,statusdesc=$3,revision=revision+1 WHERE ${key}=$1 AND revision=$4 RETURNING ${key} AS id,userid AS "userId",status,revision`,
        [id, status, reason, revision],
      )
    ).rows[0];
  }
  async createPayment(
    userId: number,
    membershipId: number | null,
    price: string,
    status: string,
    method: string,
    reference: string,
    reason: string,
    actorId: number,
  ) {
    return (
      await this.db.query(
        `INSERT INTO payment(userid,membershipid,price,paymentstatus,paymentdate,method,reference,note,recorded_by)
      VALUES($1,$2,$3,$4,NOW() AT TIME ZONE 'UTC',$5,$6,$7,$8) RETURNING paymentid AS id`,
        [
          userId,
          membershipId,
          price,
          status,
          method,
          reference,
          reason,
          actorId,
        ],
      )
    ).rows[0]!.id as number;
  }
  async linkPassPayment(passId: number, paymentId: number) {
    await this.db.query("UPDATE day_pass SET paymentid=$2 WHERE dayid=$1", [
      passId,
      paymentId,
    ]);
  }
  async payment(id: number) {
    return (
      await this.db.query(
        `SELECT paymentid AS id,userid AS "userId",price::text AS amount,paymentstatus AS status,method,reference,note,revision FROM payment WHERE paymentid=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  async updatePayment(
    id: number,
    status: string,
    method: string,
    reference: string,
    reason: string,
    revision: number,
  ) {
    return (
      await this.db.query(
        `UPDATE payment SET paymentstatus=$2::text,method=$3,reference=$4,note=$5,revision=revision+1,updated_at=NOW(),
      price=CASE WHEN $2::text='waived' THEN 0 ELSE price END WHERE paymentid=$1 AND revision=$6
      RETURNING paymentid AS id,userid AS "userId",price::text AS amount,paymentstatus AS status,method,reference,note,revision`,
        [id, status, method, reference, reason, revision],
      )
    ).rows[0];
  }
  async payments(userId: number | null, offset = 0) {
    return (
      await this.db.query(
        `SELECT p.paymentid AS id,p.userid AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      p.membershipid AS "membershipId",d.dayid AS "dayPassId",p.price::text AS amount,p.paymentstatus AS status,p.method,p.reference,p.revision,
      p.paymentdate AT TIME ZONE 'UTC' AS "recordedAt",p.updated_at AS "updatedAt",
      COALESCE(m.plan_snapshot->>'name',d.plan_snapshot->>'name',t.tiername,'Legacy record') AS "planName"
      FROM payment p LEFT JOIN "user" u USING(userid) LEFT JOIN user_membership m USING(membershipid)
      LEFT JOIN membership_tiers t ON m.tierid=t.tierid LEFT JOIN LATERAL(SELECT * FROM day_pass WHERE paymentid=p.paymentid ORDER BY dayid LIMIT 1) d ON true
      WHERE ($1::int IS NULL OR p.userid=$1) ORDER BY p.paymentid DESC LIMIT 51 OFFSET $2`,
        [userId, offset],
      )
    ).rows;
  }
  async audit(
    actor: number,
    subject: number | null,
    action: string,
    type: string,
    id: number,
    reason: string,
    before: unknown,
    after: unknown,
  ) {
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
  async audits(userId: number | null, offset = 0) {
    return (
      await this.db.query(
        `SELECT a.id::text,a.actor_id AS "actorId",u.firstname || ' ' || u.lastname AS "actorName",a.subject_id AS "subjectId",a.action,
      a.entity_type AS "entityType",a.entity_id AS "entityId",a.reason,a.before_state AS "before",a.after_state AS "after",a.created_at AS "createdAt"
      FROM app_staff_audit a JOIN "user" u ON a.actor_id=u.userid WHERE ($1::int IS NULL OR subject_id=$1) ORDER BY a.id DESC LIMIT 51 OFFSET $2`,
        [userId, offset],
      )
    ).rows;
  }
  async request(id: string) {
    return (
      await this.db.query(
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
  ) {
    await this.db.query(
      "INSERT INTO app_issuance_request(request_id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4)",
      [id, actorId, fingerprint, JSON.stringify(result)],
    );
  }
  async policies() {
    return (
      await this.db.query(
        `SELECT waiverid AS id,name,version,description,effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",isactive AS active,required,approval_reference AS "approvalReference" FROM waiver ORDER BY effectivedate DESC NULLS LAST,waiverid DESC`,
      )
    ).rows;
  }
  async createPolicy(
    name: string,
    version: string,
    description: string,
    effectiveAt: string,
    approvalReference: string,
    actorId: number,
  ) {
    return (
      await this.db.query(
        `INSERT INTO waiver(name,version,description,effectivedate,approval_reference,created_by) VALUES($1,$2,$3,$4::timestamptz AT TIME ZONE 'UTC',$5,$6)
      RETURNING waiverid AS id,name,version,description,effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",approval_reference AS "approvalReference"`,
        [name, version, description, effectiveAt, approvalReference, actorId],
      )
    ).rows[0]!;
  }
  async complianceOptions() {
    const [waivers, certifications] = await Promise.all([
      this.db.query(
        `WITH current_waivers AS (
          SELECT DISTINCT ON (name) waiverid AS id,name,version
          FROM waiver
          WHERE isactive=true AND required=true
            AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
        )
        SELECT id,name,version FROM current_waivers ORDER BY name`,
      ),
      this.db.query(
        `SELECT certid AS id,name FROM certifications
        WHERE (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          AND (enddate IS NULL OR enddate>=NOW() AT TIME ZONE 'UTC')
        ORDER BY name,certid`,
      ),
    ]);
    return { waivers: waivers.rows, certifications: certifications.rows };
  }
  async compliance(filters: ComplianceFilters, includeAllRows = false) {
    const limit = includeAllRows ? 10000 : 51;
    const params = [
      filters.waiverId,
      filters.certificationId,
      filters.expiresWithinDays,
      filters.userStatus,
      filters.offset,
      limit,
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
      current_certifications AS (
        SELECT certid,name FROM certifications
        WHERE (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          AND (enddate IS NULL OR enddate>=NOW() AT TIME ZONE 'UTC')
          AND ($2::int IS NULL OR certid=$2)
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
        SELECT ru.userid,c.certid,c.name,uc.status,uc.renewaldate,
          (uc.usercertid IS NOT NULL AND uc.status='active'
            AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')) AS compliant,
          (uc.usercertid IS NOT NULL AND uc.renewaldate IS NOT NULL AND uc.renewaldate<NOW() AT TIME ZONE 'UTC') AS expired,
          (uc.usercertid IS NOT NULL AND uc.renewaldate IS NOT NULL AND $3::int IS NOT NULL
            AND uc.renewaldate<=NOW() AT TIME ZONE 'UTC'+make_interval(days=>$3::int)) AS expiring
        FROM report_users ru CROSS JOIN current_certifications c
        LEFT JOIN LATERAL (
          SELECT usercertid,status,renewaldate FROM user_certifications
          WHERE userid=ru.userid AND certid=c.certid
          ORDER BY renewaldate DESC NULLS LAST,usercertid DESC LIMIT 1
        ) uc ON true
      ),
      user_rollup AS (
        SELECT ru.userid AS id,ru.firstname AS "firstName",ru.lastname AS "lastName",ru.email,ru.status,ru.accessstatus AS "accessStatus",
          COALESCE((SELECT bool_and(compliant) FROM waiver_status ws WHERE ws.userid=ru.userid),true) AS "waiverCompliant",
          COALESCE((SELECT bool_and(compliant) FROM certification_status cs WHERE cs.userid=ru.userid),true) AS "certificationCompliant",
          COALESCE((SELECT array_agg(name || ' ' || version ORDER BY name) FROM waiver_status ws WHERE ws.userid=ru.userid AND NOT compliant),'{}') AS "missingWaivers",
          COALESCE((SELECT array_agg(name || ' ' || version ORDER BY name) FROM waiver_status ws WHERE ws.userid=ru.userid AND expiring),'{}') AS "expiringWaivers",
          COALESCE((SELECT array_agg(name ORDER BY name) FROM certification_status cs WHERE cs.userid=ru.userid AND NOT compliant),'{}') AS "missingCertifications",
          COALESCE((SELECT array_agg(name ORDER BY name) FROM certification_status cs WHERE cs.userid=ru.userid AND expiring),'{}') AS "expiringCertifications"
        FROM report_users ru
      ),
      filtered_users AS (
        SELECT * FROM user_rollup
        WHERE $3::int IS NULL OR array_length("expiringWaivers",1) IS NOT NULL OR array_length("expiringCertifications",1) IS NOT NULL
      ),
      summary AS (
        SELECT COUNT(*)::int AS "userCount",
          COUNT(*) FILTER (WHERE "waiverCompliant" AND "certificationCompliant")::int AS "compliantUsers",
          COUNT(*) FILTER (WHERE "waiverCompliant")::int AS "waiverCompliantUsers",
          COUNT(*) FILTER (WHERE "certificationCompliant")::int AS "certificationCompliantUsers"
        FROM filtered_users
      )
      SELECT
        (SELECT row_to_json(summary) FROM summary) AS summary,
        COALESCE((SELECT json_agg(row_to_json(paged) ORDER BY "lastName","firstName",id)
          FROM (SELECT * FROM filtered_users ORDER BY "lastName","firstName",id LIMIT $6 OFFSET $5) paged),'[]'::json) AS users,
        COALESCE((SELECT json_agg(row_to_json(w) ORDER BY name)
          FROM (SELECT waiverid AS id,name,version,COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE compliant)::int AS compliant,
            COUNT(*) FILTER (WHERE expiring)::int AS expiring
            FROM waiver_status GROUP BY waiverid,name,version) w),'[]'::json) AS "waiverBreakdown",
        COALESCE((SELECT json_agg(row_to_json(c) ORDER BY name)
          FROM (SELECT certid AS id,name,COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE compliant)::int AS compliant,
            COUNT(*) FILTER (WHERE expiring)::int AS expiring
            FROM certification_status GROUP BY certid,name) c),'[]'::json) AS "certificationBreakdown",
        (SELECT COUNT(*)::int FROM filtered_users) AS "filteredCount"`;
    const row = (await this.db.query(query, params)).rows[0]!;
    const summary = row.summary ?? {
      userCount: 0,
      compliantUsers: 0,
      waiverCompliantUsers: 0,
      certificationCompliantUsers: 0,
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
