import { ANNUAL_VALIDITY_DAYS } from "../../annualValidity.js";
import type { Database } from "../../db.js";
import type { PolicyScope } from "../../staffDomain.js";

export interface PolicyRecord {
  id: number;
  name: string;
  version: string;
  description: string | null;
  effectiveAt: Date | null;
  active: boolean;
  required: boolean;
  approvalReference: string | null;
  validityDays: number | null;
  scope: PolicyScope;
}

const policyColumns = `waiverid AS id,name,version,description,effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",isactive AS active,required,approval_reference AS "approvalReference",validity_days AS "validityDays",policy_scope AS scope`;

/** Waiver/policy versions (waiver). */
export class PolicyRepository {
  constructor(private db: Database) {}
  async policies(): Promise<PolicyRecord[]> {
    return (
      await this.db.query<PolicyRecord>(
        `SELECT ${policyColumns} FROM waiver ORDER BY effectivedate DESC NULLS LAST,waiverid DESC`,
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
    validityDays: number = ANNUAL_VALIDITY_DAYS,
    scope: PolicyScope = 'facility',
  ): Promise<PolicyRecord> {
    return (
      await this.db.query<PolicyRecord>(
        `INSERT INTO waiver(name,version,description,effectivedate,approval_reference,created_by,validity_days,policy_scope) VALUES($1,$2,$3,$4::timestamptz AT TIME ZONE 'UTC',$5,$6,$7,$8)
      RETURNING ${policyColumns}`,
        [name, version, description, effectiveAt, approvalReference, actorId, validityDays, scope],
      )
    ).rows[0]!;
  }
}
