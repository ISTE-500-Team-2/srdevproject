import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { accessDeadline } from '../../src/accessDeadline.js';

const database = `arbor_deadline_${randomBytes(6).toString('hex')}_mvc_test`;
const admin = new Pool(), pool = new Pool({database});
const user = 900001, tz = 'America/New_York';
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await admin.query(`CREATE DATABASE "${database}"`);
  await initializeDemo(pool);
});
after(async () => {await pool.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end();});
async function fixture(run: (db: PoolClient, at: Date) => Promise<void>, instant='2026-11-02T04:59:58.000Z') {
  const db=await pool.connect(), at=new Date(instant);
  try {
    await db.query('BEGIN');
    await db.query(`INSERT INTO "user"(userid,firstname,lastname,email,password,phone,status)
      VALUES($1,'Deadline','Fixture','deadline@example.invalid','not-a-login','0000000000','active')`,[user]);
    await db.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
      VALUES($1,1,'2026-01-01','2028-01-01','active')`,[user]);
    await db.query(`INSERT INTO waiver(waiverid,name,version,effectivedate,isactive,required)
      VALUES(900002,'Deadline required policy','1','2026-01-01',true,true)`);
    await db.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval)
      SELECT $1,waiverid,'2026-01-01',true FROM waiver WHERE isactive AND required`,[user]);
    await run(db,at);
  } finally {await db.query('ROLLBACK');db.release();}
}
const deadline=(db: PoolClient,at: Date,end=10000,equipment?:number)=>accessDeadline(db,tz,user,new Date(at.getTime()+end),equipment,at);

test('reservation end and five-second renewal cap are hard limits',()=>fixture(async(db,at)=>{
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+5000);
  assert.equal((await deadline(db,at,1200)).getTime(),at.getTime()+1200);
  assert.equal((await deadline(db,at,0)).getTime(),at.getTime());
}));
test('membership expiry is bounded; a valid day pass can cover an expiring membership',()=>fixture(async(db,at)=>{
  await db.query("UPDATE user_membership SET end_date=$2::timestamptz AT TIME ZONE 'UTC' WHERE userid=$1",[user,new Date(at.getTime()+600)]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+600);
  await db.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,'2026-11-01','active')",[user]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+2000);
  await db.query("UPDATE day_pass SET status='inactive' WHERE userid=$1",[user]);
  await db.query("UPDATE user_membership SET status='expired' WHERE userid=$1",[user]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime());
}));
for(const [label,at,day] of [
  ['spring DST day','2026-03-09T03:59:58Z','2026-03-08'],
  ['fall DST day','2026-11-02T04:59:58Z','2026-11-01'],
]) test(`day pass stops at local midnight after ${label}`,()=>fixture(async(db,at)=>{
  await db.query("UPDATE user_membership SET status='expired' WHERE userid=$1",[user]);
  await db.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,$2,'active')",[user,day]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+2000);
},at));
test('only current required policy signatures limit the lease, not obsolete signatures',()=>fixture(async(db,at)=>{
  await db.query('UPDATE user_waiver SET expires_at=$2 WHERE userid=$1',[user,new Date(at.getTime()+700)]);
  await db.query(`INSERT INTO waiver(waiverid,name,version,effectivedate,isactive,required)
    VALUES(900003,'Deadline required policy','0','2025-01-01',false,true)`);
  await db.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval,expires_at)
    VALUES($1,900003,'2025-01-01',true,$2)`,[user,new Date(at.getTime()+200)]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+700);
  await db.query('UPDATE user_waiver SET expires_at=NULL WHERE userid=$1 AND waiverid<>900003',[user]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+5000);
  await db.query("UPDATE user_waiver SET approval=false WHERE userid=$1",[user]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime());
}));
test('scheduled required policy activation ends the old grant',()=>fixture(async(db,at)=>{
  await db.query(`INSERT INTO waiver(waiverid,name,version,effectivedate,isactive,required)
    VALUES(900001,'New required policy','2',$1::timestamptz AT TIME ZONE 'UTC',true,true)`,[new Date(at.getTime()+900)]);
  assert.equal((await deadline(db,at)).getTime(),at.getTime()+900);
}));
test('machine certification expiry and revocation bound grants',()=>fixture(async(db,at)=>{
  await db.query("INSERT INTO certifications(certid,name) VALUES(900001,'Test machine training')");
  const machine=(await db.query("INSERT INTO equipment(name,certid,status) VALUES('Deadline machine',900001,'available') RETURNING equipmentid")).rows[0].equipmentid;
  await db.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
    VALUES(900001,$1,900001,'active',$2::timestamptz AT TIME ZONE 'UTC')`,[user,new Date(at.getTime()+1000)]);
  assert.equal((await deadline(db,at,10000,machine)).getTime(),at.getTime()+1000);
  await db.query("UPDATE user_certifications SET status='revoked' WHERE userid=$1",[user]);
  assert.equal((await deadline(db,at,10000,machine)).getTime(),at.getTime());
}));
