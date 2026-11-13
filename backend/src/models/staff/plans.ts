import type { Database } from "../../db.js";
import type { PlanInput } from "../../staffDomain.js";

export interface Plan extends PlanInput {
  id: number;
  revision: number;
}

const planColumns =
  "tierid AS id,tiername AS name,kind,tierprice::text AS price,allottedmonths AS months,benefits,active,revision";

/** Membership and day-pass catalogue (membership_tiers). */
export class PlanRepository {
  constructor(private db: Database) {}
  async plans(activeOnly = false): Promise<Plan[]> {
    return (
      await this.db.query<Plan>(
        `SELECT ${planColumns} FROM membership_tiers ${activeOnly ? "WHERE active=true" : ""} ORDER BY kind,tiername,tierid`,
      )
    ).rows;
  }
  async plan(id: number, lock = false): Promise<Plan | undefined> {
    return (
      await this.db.query<Plan>(
        `SELECT ${planColumns} FROM membership_tiers WHERE tierid=$1 ${lock ? "FOR SHARE" : ""}`,
        [id],
      )
    ).rows[0];
  }
  async createPlan(input: PlanInput): Promise<Plan> {
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
  async updatePlan(id: number, input: PlanInput, revision: number): Promise<Plan | undefined> {
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
}
