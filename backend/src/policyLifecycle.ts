import type {Pool} from 'pg';
import {transaction, type Database} from './db.js';
import {StaffModel, type PolicyRecord} from './models/StaffModel.js';

/** Caller holds the staff-write transaction lock. Future versions remain published
 * but cannot retire today's agreement until their effective time has arrived.
 * Match EligibilityModel's effective-date/id ordering, including null dates.
 */
export async function retireSupersededPolicies(
  db:Database,
  options:{name?:string;actorId?:number;reason?:string}={},
):Promise<number[]> {
  const rows=(await db.query<PolicyRecord & {supersededBy:number;replacementPublishedBy:number|null}>(`
    WITH current_versions AS (
      SELECT DISTINCT ON (name) waiverid,name,created_by
      FROM waiver WHERE isactive=true
        AND (effectivedate IS NULL OR effectivedate<=statement_timestamp() AT TIME ZONE 'UTC')
        AND ($1::text IS NULL OR name=$1)
      ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
    )
    SELECT w.waiverid AS id,w.name,w.version,w.description,
      w.effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",w.isactive AS active,w.required,
      w.approval_reference AS "approvalReference",c.waiverid AS "supersededBy",
      c.created_by AS "replacementPublishedBy"
    FROM waiver w JOIN current_versions c ON c.name=w.name
    WHERE w.isactive=true AND w.waiverid<>c.waiverid
      AND (w.effectivedate IS NULL OR w.effectivedate<=statement_timestamp() AT TIME ZONE 'UTC')
    ORDER BY w.waiverid FOR UPDATE OF w`,[options.name??null])).rows;
  const model=new StaffModel(db,'UTC');
  for(const {supersededBy,replacementPublishedBy,...before} of rows) {
    await db.query('UPDATE waiver SET isactive=false WHERE waiverid=$1',[before.id]);
    await model.audit(options.actorId??null,null,'policy.retired','waiver',before.id,
      options.reason??'Scheduled replacement became effective',before,
      {...before,active:false,supersededBy,replacementPublishedBy});
  }
  return rows.map(row=>row.id);
}

/** System retirement is serialized with publication/manual retirement. It records
 * a System actor rather than impersonating the original publisher; the replacement
 * ID and publisher are retained as context in the audit event.
 */
export function runPolicyRetirement(pool:Pool):Promise<number> {
  return transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'))");
    return (await retireSupersededPolicies(db)).length;
  });
}

/** Independent of notification/provider configuration. Eligibility already selects
 * the newest effective version at access time; this scan persists retired flags
 * and their audit trail after scheduled versions take effect.
 */
export function startPolicyRuntime(pool:Pool) {
  let stopped=false;
  let pending:Promise<void>|undefined;
  const tick=()=>{
    if(stopped || pending)return;
    pending=runPolicyRetirement(pool).then(()=>{}).catch(()=>{
      console.error('Policy retirement scan failed; retrying on the next interval');
    }).finally(()=>{pending=undefined;});
  };
  const timer=setInterval(tick,15_000);
  timer.unref();
  tick();
  return {stop:async()=>{stopped=true;clearInterval(timer);await pending;}};
}
