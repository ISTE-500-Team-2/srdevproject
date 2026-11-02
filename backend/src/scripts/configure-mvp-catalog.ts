import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool, transaction, type Database } from '../db.js';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { StaffModel } from '../models/StaffModel.js';

const groups=[{name:'CNC Training',machines:['Joey','Ross','Chandler']},
  {name:'Metal Lathe Training',machines:['Kirk']},{name:'Wood Lathe Training',machines:['Spock']}];
async function preview(db:Database) {
  const equipment=(await db.query('SELECT equipmentid AS id,name,status,certid FROM equipment ORDER BY equipmentid')).rows;
  const namedCnc=groups[0]!.machines.every(name=>equipment.some(e=>e.name===name));
  const retire=equipment.filter(e=>e.name==='Welding Station'||(e.name==='CNC Machine'&&namedCnc));
  return {retire,training:groups.map(g=>({...g,durationMinutes:60,feeCents:2000,
    equipment:equipment.filter(e=>g.machines.includes(e.name))})),
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
      if(!cert) cert=(await db.query(`INSERT INTO certifications(certid,name,description,effectivedate)
        SELECT COALESCE(MAX(certid),0)+1,$1,'One-hour instructor-led safety training. Training fee: $20. Staff must configure the approved certification validity.',NOW() AT TIME ZONE 'UTC'
        FROM certifications RETURNING certid`,[group.name])).rows[0];
      await db.query(`INSERT INTO app_training_requirement(certification_id,duration_minutes,fee_cents) VALUES($1,60,2000)
        ON CONFLICT(certification_id) DO NOTHING`,[cert.certid]);
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
