import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool, transaction, type Database } from '../db.js';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { StaffModel } from '../models/StaffModel.js';

const groups=[{name:'CNC Training',machines:['Joey','Ross','Chandler']},
  {name:'Metal Lathe Training',machines:['Kirk']},{name:'Wood Lathe Training',machines:['Spock']}];
// Defaults used only when creating a missing definition or filling an unset fee.
// Training policy lives on certifications (migration 035); configured values are never overwritten.
const defaultMinutes=60,defaultFeeCents=2000;
type Pricing={minutes:number;feeCents:number|null};
async function preview(db:Database) {
  const equipment=(await db.query('SELECT equipmentid AS id,name,status,certid FROM equipment ORDER BY equipmentid')).rows;
  const namedCnc=groups[0]!.machines.every(name=>equipment.some(e=>e.name===name));
  const retire=equipment.filter(e=>e.name==='Welding Station'||(e.name==='CNC Machine'&&namedCnc));
  const certs=(await db.query<{name:string;certid:number;minutes:number;feeCents:number|null}>(`SELECT DISTINCT ON(name) name,certid,
    training_minutes AS minutes,training_fee_cents AS "feeCents" FROM certifications WHERE name=ANY($1::text[]) ORDER BY name,certid`,
    [groups.map(g=>g.name)])).rows;
  return {retire,training:groups.map(g=>{
    const cert=certs.find(c=>c.name===g.name);
    const current:Pricing|null=cert?{minutes:cert.minutes,feeCents:cert.feeCents}:null;
    const proposed:Pricing=current?{minutes:current.minutes,feeCents:current.feeCents??defaultFeeCents}
      :{minutes:defaultMinutes,feeCents:defaultFeeCents};
    const action=!current?'create':current.feeCents===null?'set-fee':'none';
    return {...g,certificationId:cert?.certid??null,current,proposed,action,
      equipment:equipment.filter(e=>g.machines.includes(e.name))};
  }),
    preservedHistory:true,expiryPolicy:'Existing certification validity is preserved. New definitions require staff to set their approved validity before training can be granted.'};
}
export async function configureMvpCatalog(pool:Pool,apply=false,actorId?:number) {
  return transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-certification-writes'))");
    const plan=await preview(db);
    if(!apply) return {...plan,applied:false};
    const actor=positiveId(actorId,'Administrator');
    const allowed=await db.query(`SELECT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid)
      WHERE u.userid=$1 AND r.role='admin' AND u.status='active' AND u.accessstatus='active'`,[actor]);
    if(!allowed.rowCount) throw new AppError(403,'ADMIN_REQUIRED','An active administrator must own this catalog change.');
    for(const e of plan.retire) {
      const inserted=await db.query(`INSERT INTO app_equipment_retirement(equipment_id,reason) VALUES($1,$2)
        ON CONFLICT(equipment_id) DO NOTHING RETURNING equipment_id`,[e.id,'MVP catalog cleanup: obsolete entry; booking and payment history retained']);
      if(inserted.rowCount) {
        await db.query("UPDATE equipment SET status='unavailable',availability_revision=availability_revision+1 WHERE equipmentid=$1",[e.id]);
        await new StaffModel(db).audit(actor,null,'equipment.retired','equipment',e.id,'Approved MVP catalog cleanup',e,{status:'unavailable'});
      }
    }
    for(const group of groups) {
      let cert=(await db.query('SELECT certid FROM certifications WHERE name=$1 ORDER BY certid LIMIT 1 FOR UPDATE',[group.name])).rows[0];
      if(!cert) cert=(await db.query(`INSERT INTO certifications(certid,name,description,effectivedate,training_fee_cents,training_minutes)
        SELECT COALESCE(MAX(certid),0)+1,$1,'One-hour instructor-led safety training. Training fee: $20. Staff must configure the approved certification validity.',NOW() AT TIME ZONE 'UTC',$2,$3
        FROM certifications RETURNING certid`,[group.name,defaultFeeCents,defaultMinutes])).rows[0];
      else {
        // A NULL fee blocks registration; fill only that gap and leave configured pricing untouched.
        const priced=await db.query(`UPDATE certifications SET training_fee_cents=$2,revision=revision+1
          WHERE certid=$1 AND training_fee_cents IS NULL RETURNING training_minutes AS minutes`,[cert.certid,defaultFeeCents]);
        if(priced.rowCount) await new StaffModel(db).audit(actor,null,'certification.training_fee_configured','certification',cert.certid,
          'MVP training: unset training fee set to $20; existing duration preserved',
          {feeCents:null,minutes:priced.rows[0].minutes},{feeCents:defaultFeeCents,minutes:priced.rows[0].minutes});
      }
      const updated=await db.query(`UPDATE equipment SET certid=$1,waiverrequired=true,availability_revision=availability_revision+1
        WHERE name=ANY($2::text[]) AND certid IS NULL RETURNING equipmentid`,[cert.certid,group.machines]);
      if(updated.rowCount) await new StaffModel(db).audit(actor,null,'equipment.training_configured','certification',cert.certid,
        'MVP training: one hour, $20; no certification granted or expiry guessed',null,{equipment:updated.rows});
    }
    return {...plan,applied:true};
  });
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const pool=createPool();
  try { const flag=process.argv.indexOf('--actor-id');
    console.log(JSON.stringify(await configureMvpCatalog(pool,process.argv.includes('--apply'),flag<0?undefined:Number(process.argv[flag+1])),null,2));
  } finally {await pool.end();}
}
