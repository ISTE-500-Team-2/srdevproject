// Certification definitions, member training records and the equipment each certification unlocks.
// Callers pass the pool or their transaction client; writes run inside the caller's transaction.

import type { Database } from "../db.js";

const definition = `c.certid AS id,c.name,c.description,c.validity_days AS "validityDays",c.revision,
 c.training_fee_cents AS "trainingFeeCents",c.training_minutes AS "trainingMinutes",
 c.effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",c.enddate AT TIME ZONE 'UTC' AS "endsAt",
 COALESCE((SELECT json_agg(e.equipmentid ORDER BY e.equipmentid) FROM equipment e WHERE e.certid=c.certid),'[]') AS "equipmentIds"`;
const record = `uc.usercertid AS id,uc.userid AS "userId",uc.certid AS "certificationId",c.name,uc.status,uc.revision,uc.training_minutes AS "trainingMinutes",
 uc.renewaldate AT TIME ZONE 'UTC' AS "expiresAt",uc.trained_at AS "trainedAt",uc.approved_at AS "approvedAt",
 uc.approved_by AS "approvedBy",a.firstname||' '||a.lastname AS "instructorName",uc.training_source AS source,
 uc.verified_in_person AS "verifiedInPerson",uc.verification_reference AS "verificationReference",uc.revoked_at AS "revokedAt",
 (uc.status='active' AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')
 AND (c.effectivedate IS NULL OR c.effectivedate<=NOW() AT TIME ZONE 'UTC')
 AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC')) AS valid`;

export class CertificationModel {
  constructor(private db: Database) {}

  /** Holds the acting user's row while their training permissions are checked. */
  async shareUser(id: number) {
    await this.db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [id]);
  }

  /** Certification writes take turns, transaction-wide. */
  async lockWrites() {
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtext('arbor-certification-writes'))",
    );
  }

  async catalog() {
    return (
      await this.db.query(
        `SELECT ${definition} FROM certifications c ORDER BY c.name,c.certid`,
      )
    ).rows;
  }

  // The catalog cards' counts: how many active members are current on each certification,
  // how many of those run out within 30 days, and how many have lapsed or been revoked.
  // Certifications nobody holds are left out.
  async holderCounts() {
    const { rows } = await this.db.query(
      `SELECT certid AS id,
         COUNT(*) FILTER (WHERE valid)::int AS current,
         COUNT(*) FILTER (WHERE valid AND expires_at<=NOW() AT TIME ZONE 'UTC'+INTERVAL '30 days')::int AS "expiringSoon",
         COUNT(*) FILTER (WHERE NOT valid AND status IS DISTINCT FROM 'revoked')::int AS expired,
         COUNT(*) FILTER (WHERE status='revoked')::int AS revoked
       FROM (SELECT uc.certid,uc.status,LEAST(uc.renewaldate,c.enddate) AS expires_at,
           COALESCE(uc.status='active' AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')
             AND (c.effectivedate IS NULL OR c.effectivedate<=NOW() AT TIME ZONE 'UTC')
             AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC'),false) AS valid
         FROM user_certifications uc JOIN certifications c USING(certid)
         JOIN "user" u ON u.userid=uc.userid
         WHERE u.status='active') held
       GROUP BY certid ORDER BY certid`,
    );
    return rows;
  }

  /** Up to 26 name/email matches, so the caller can tell whether there are more than 25. */
  async searchMembers(search: string, instructorsOnly: boolean) {
    const { rows } = await this.db.query(
      `SELECT u.userid AS id,u.firstname||' '||u.lastname AS name,u.email
       FROM "user" u WHERE strpos(lower(u.firstname||' '||u.lastname||' '||u.email),lower($1))>0
       AND (NOT $2::boolean OR (u.status='active' AND u.accessstatus='active' AND EXISTS
         (SELECT 1 FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid AND r.role='instructor')))
       ORDER BY u.lastname,u.firstname,u.userid LIMIT 26`,
      [search, instructorsOnly],
    );
    return rows;
  }

  async nextId() {
    return (
      await this.db.query(
        "SELECT COALESCE(MAX(certid),0)+1 AS id FROM certifications",
      )
    ).rows[0]!.id;
  }

  async create(id: number, name: string, description: string, days: unknown, fee: number | null, minutes: number) {
    await this.db.query(
      "INSERT INTO certifications(certid,name,description,effectivedate,validity_days,training_fee_cents,training_minutes) VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC',$4,$5,$6)",
      [id, name, description, days, fee, minutes],
    );
  }

  async definition(id: number) {
    return (
      await this.db.query(
        `SELECT ${definition} FROM certifications c WHERE certid=$1`,
        [id],
      )
    ).rows[0];
  }

  async lockDefinition(id: number) {
    return (
      await this.db.query(
        `SELECT ${definition} FROM certifications c WHERE certid=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }

  async update(id: number, name: string, description: string, days: unknown, fee: number | null, minutes: number) {
    await this.db.query(
      "UPDATE certifications SET name=$2,description=$3,validity_days=$4,training_fee_cents=$5,training_minutes=$6,revision=revision+1 WHERE certid=$1",
      [id, name, description, days, fee, minutes],
    );
  }

  async backfillExpiry(id: number) {
    await this.db.query("SELECT app_backfill_certification_expiry($1)", [id]);
  }

  async memberRecords(userId: number) {
    return (
      await this.db.query(
        `SELECT ${record} FROM user_certifications uc JOIN certifications c USING(certid) LEFT JOIN "user" a ON a.userid=uc.approved_by WHERE uc.userid=$1 ORDER BY c.name`,
        [userId],
      )
    ).rows;
  }

  async shareCertification(id: number) {
    return (
      await this.db.query(
        "SELECT *, effectivedate AT TIME ZONE 'UTC' AS effectivedate,enddate AT TIME ZONE 'UTC' AS enddate FROM certifications WHERE certid=$1 FOR SHARE",
        [id],
      )
    ).rows[0];
  }

  /** The member's stored training row, locked, or null when there is none. */
  async lockTraining(userId: number, id: number) {
    return (
      (
        await this.db.query(
          "SELECT * FROM user_certifications WHERE userid=$1 AND certid=$2 FOR UPDATE",
          [userId, id],
        )
      ).rows[0] ?? null
    );
  }

  async nextTrainingId() {
    return (
      await this.db.query(
        "SELECT COALESCE(MAX(usercertid),0)+1 AS id FROM user_certifications",
      )
    ).rows[0]!.id;
  }

  async approve(values: unknown[]) {
    await this.db.query(
      `INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status,statusdesc,trained_at,approved_at,approved_by,verification_reference,training_source,verified_in_person,training_minutes)
    VALUES($1,$2,$3,$4::timestamptz AT TIME ZONE 'UTC','active',$5,$6,NOW(),$7,$8,$9,true,$10)
    ON CONFLICT(userid,certid) DO UPDATE SET renewaldate=EXCLUDED.renewaldate,status='active',statusdesc=EXCLUDED.statusdesc,trained_at=EXCLUDED.trained_at,approved_at=NOW(),approved_by=EXCLUDED.approved_by,verification_reference=EXCLUDED.verification_reference,training_source=EXCLUDED.training_source,verified_in_person=true,training_minutes=EXCLUDED.training_minutes,revision=user_certifications.revision+1`,
      values,
    );
  }

  async memberRecord(userId: number, id: number) {
    return (
      await this.db.query(
        `SELECT ${record} FROM user_certifications uc JOIN certifications c USING(certid) LEFT JOIN "user" a ON a.userid=uc.approved_by WHERE uc.userid=$1 AND uc.certid=$2`,
        [userId, id],
      )
    ).rows[0];
  }

  /** The locked training row plus app_granting: whether it was letting the member in (active, not past renewal). */
  async lockTrainingForRevoke(userId: number, id: number) {
    return (
      await this.db.query(
        `SELECT *,(status='active' AND (renewaldate IS NULL OR renewaldate>=NOW() AT TIME ZONE 'UTC')) AS app_granting
            FROM user_certifications WHERE userid=$1 AND certid=$2 FOR UPDATE`,
        [userId, id],
      )
    ).rows[0];
  }

  async revoke(userId: number, id: number, reason: string) {
    return (
      await this.db.query(
        "UPDATE user_certifications SET status='revoked',revoked_at=NOW(),statusdesc=$3,revision=revision+1 WHERE userid=$1 AND certid=$2 RETURNING *",
        [userId, id, reason],
      )
    ).rows[0];
  }

  async hasEnded(id: number) {
    return (
      await this.db.query<{ ended: boolean }>(
        "SELECT enddate IS NOT NULL AND enddate<NOW() AT TIME ZONE 'UTC' AS ended FROM certifications WHERE certid=$1",
        [id],
      )
    ).rows[0]?.ended;
  }

  async lockEquipment(equipmentId: number) {
    return (
      await this.db.query(
        "SELECT certid FROM equipment WHERE equipmentid=$1 FOR UPDATE",
        [equipmentId],
      )
    ).rows[0];
  }

  async requireForEquipment(equipmentId: number, id: number) {
    await this.db.query("UPDATE equipment SET certid=$2 WHERE equipmentid=$1", [
      equipmentId,
      id,
    ]);
  }
}
