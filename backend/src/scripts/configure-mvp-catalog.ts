// Operator-run catalog configuration with a preview path; kept separate from normal startup and
// member requests.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool, transaction, type Database } from '../db.js';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { StaffModel } from '../models/StaffModel.js';

// Migration 032_training_pricing creates these courses and links the machines to them. Earlier runs
// of this script looked for the legacy "... Training" names instead, found none and created
// look-alike courses that unlock no machine.
const groups=[{name:'CNC',legacyName:'CNC Training',machines:['Joey','Ross','Chandler']},
  {name:'Metal Lathe',legacyName:'Metal Lathe Training',machines:['Kirk']},
  {name:'Wood Lathe',legacyName:'Wood Lathe Training',machines:['Spock']}];
// Descriptions written by migration 032 and by earlier runs of this script. A course staff have
// since edited is never treated as a generated duplicate.
const generatedDescriptions=['One-hour instructor-verified equipment training',
  'One-hour instructor-led safety training. Training fee: $20. Staff must configure the approved certification validity.'];
// Defaults used only when creating a missing definition or filling an unset fee.
// Training policy lives on certifications (migration 035); configured values are never overwritten.
const defaultMinutes=60,defaultFeeCents=2000;
type Pricing={minutes:number;feeCents:number|null};
type Course={certid:number;name:string;description:string|null;minutes:number;feeCents:number|null;linked:boolean;members:number;classes:number};
async function preview(db:Database) {
  const equipment=(await db.query<{id:number;name:string;status:string;certid:number|null}>(
    'SELECT equipmentid AS id,name,status,certid FROM equipment ORDER BY equipmentid')).rows;
  const namedCnc=groups[0]!.machines.every(name=>equipment.some(e=>e.name===name));
  const retire=equipment.filter(e=>e.name==='Welding Station'||(e.name==='CNC Machine'&&namedCnc));
  const machineCerts=equipment.flatMap(e=>e.certid!==null&&groups.some(g=>g.machines.includes(e.name))?[e.certid]:[]);
  const certs=(await db.query<Course>(`SELECT c.certid,c.name,c.description,c.training_minutes AS minutes,c.training_fee_cents AS "feeCents",
    EXISTS(SELECT 1 FROM equipment e WHERE e.certid=c.certid) AS linked,
    (SELECT count(*)::int FROM user_certifications uc WHERE uc.certid=c.certid) AS members,
    (SELECT count(*)::int FROM app_training_class t WHERE t.certification_id=c.certid) AS classes
    FROM certifications c WHERE c.name=ANY($1::text[]) OR c.certid=ANY($2::int[]) ORDER BY c.certid`,
    [groups.flatMap(g=>[g.name,g.legacyName]),machineCerts])).rows;
  return {retire,training:groups.map(g=>{
    const machines=equipment.filter(e=>g.machines.includes(e.name));
    // The course these machines already require wins (the most common one, then the oldest);
    // otherwise reuse a course by name and create one only when none exists.
    const usage=new Map<number,number>();
    for(const m of machines) if(m.certid!==null) usage.set(m.certid,(usage.get(m.certid)??0)+1);
    const required=[...usage].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0]?.[0];
    const cert=certs.find(c=>c.certid===required)??certs.find(c=>c.name===g.name)??certs.find(c=>c.name===g.legacyName)??null;
    const current:Pricing|null=cert?{minutes:cert.minutes,feeCents:cert.feeCents}:null;
    const proposed:Pricing=current?{minutes:current.minutes,feeCents:current.feeCents??defaultFeeCents}
      :{minutes:defaultMinutes,feeCents:defaultFeeCents};
    const action=!current?'create':current.feeCents===null?'set-fee':'none';
    // Generated look-alikes of this course that unlock no machine; apply merges them into it.
    const duplicates=cert?certs.filter(c=>c!==cert&&!c.linked&&[g.name,g.legacyName].includes(c.name)
      &&generatedDescriptions.includes(c.description??''))
      .map(c=>({certificationId:c.certid,name:c.name,members:c.members,classes:c.classes})):[];
    return {name:cert?.name??g.name,machines:g.machines,certificationId:cert?.certid??null,current,proposed,action,
      equipment:machines,link:machines.filter(m=>m.certid===null),duplicates};
  }),
    preservedHistory:true,expiryPolicy:'Existing certification validity is preserved. New definitions require staff to set their approved validity before training can be granted.'};
}
// Training recorded under a look-alike course was meant for the real one, so it moves there and
// unlocks the member's machines. A member who already holds the real course keeps both records,
// and a look-alike anyone still holds is kept rather than deleted.
async function mergeDuplicate(db:Database,actor:number,from:number,into:number) {
  const model=new StaffModel(db);
  const moved=(await db.query<{id:number;userId:number}>(`UPDATE user_certifications uc SET certid=$2,revision=revision+1
    WHERE certid=$1 AND NOT EXISTS(SELECT 1 FROM user_certifications x WHERE x.userid=uc.userid AND x.certid=$2)
    RETURNING usercertid AS id,userid AS "userId"`,[from,into])).rows;
  for(const record of moved) await model.audit(actor,record.userId,'training.course_merged','user_certification',record.id,
    'MVP catalog: training recorded under a duplicate course moved to the course its machines require',{certificationId:from},{certificationId:into});
  const classes=(await db.query<{id:number}>(`UPDATE app_training_class SET certification_id=$2,revision=revision+1
    WHERE certification_id=$1 RETURNING id`,[from,into])).rows;
  // The retired requirement table still references the course (migration 035).
  await db.query('DELETE FROM app_training_requirement WHERE certification_id=$1',[from]);
  const removed=(await db.query(`DELETE FROM certifications c WHERE certid=$1
    AND NOT EXISTS(SELECT 1 FROM equipment WHERE certid=$1) AND NOT EXISTS(SELECT 1 FROM user_certifications WHERE certid=$1)
    RETURNING certid,name,description`,[from])).rows[0];
  if(moved.length||classes.length||removed) await model.audit(actor,null,'certification.duplicate_merged','certification',from,
    'MVP catalog: duplicate course merged into the course its machines require',removed??{certificationId:from},
    {certificationId:into,movedTraining:moved.map(r=>r.id),movedClasses:classes.map(c=>c.id),deleted:!!removed});
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
    for(const group of plan.training) {
      let certid=group.certificationId;
      if(certid===null) certid=(await db.query<{certid:number}>(`INSERT INTO certifications(certid,name,description,effectivedate,training_fee_cents,training_minutes)
        SELECT COALESCE(MAX(certid),0)+1,$1,'One-hour instructor-led safety training. Training fee: $20. Staff must configure the approved certification validity.',NOW() AT TIME ZONE 'UTC',$2,$3
        FROM certifications RETURNING certid`,[group.name,defaultFeeCents,defaultMinutes])).rows[0]!.certid;
      else {
        // A NULL fee blocks registration; fill only that gap and leave configured pricing untouched.
        const priced=await db.query(`UPDATE certifications SET training_fee_cents=$2,revision=revision+1
          WHERE certid=$1 AND training_fee_cents IS NULL RETURNING training_minutes AS minutes`,[certid,defaultFeeCents]);
        if(priced.rowCount) await new StaffModel(db).audit(actor,null,'certification.training_fee_configured','certification',certid,
          'MVP training: unset training fee set to $20; existing duration preserved',
          {feeCents:null,minutes:priced.rows[0].minutes},{feeCents:defaultFeeCents,minutes:priced.rows[0].minutes});
      }
      const updated=await db.query(`UPDATE equipment SET certid=$1,waiverrequired=true,availability_revision=availability_revision+1
        WHERE name=ANY($2::text[]) AND certid IS NULL RETURNING equipmentid`,[certid,group.machines]);
      if(updated.rowCount) await new StaffModel(db).audit(actor,null,'equipment.training_configured','certification',certid,
        'MVP training: one hour, $20; no certification granted or expiry guessed',null,{equipment:updated.rows});
      for(const duplicate of group.duplicates) await mergeDuplicate(db,actor,duplicate.certificationId,certid);
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
