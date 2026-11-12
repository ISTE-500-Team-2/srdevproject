import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {UserModel} from '../../src/models/UserModel.js';
const database='arbor_identity_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);await initializeDemo(pool);
});
after(async()=>{await pool.end();await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
async function userWith(email:string,roles:string[],activeMembership:boolean){
 const id=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
   VALUES('Identity','Fixture',$1,'x','1112223333','1990-01-01','active',true) RETURNING userid`,[email])).rows[0].userid;
 for(const role of roles)await pool.query('INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role=$2',[id,role]);
 if(activeMembership)await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
   VALUES($1,1,(now()-interval '1 day') AT TIME ZONE 'UTC',(now()+interval '30 days') AT TIME ZONE 'UTC','active')`,[id]);
 return id;
}
test('authentication and profile projections agree on role, roles and membership',async()=>{
 const model=new UserModel(pool);
 const cases=[
  {email:'identity-admin@example.invalid',roles:['admin','staff'],membership:false,expect:{role:'admin',roles:['admin','staff'],membership:'None'}},
  {email:'identity-staff@example.invalid',roles:['staff'],membership:false,expect:{role:'staff',roles:['staff'],membership:'None'}},
  {email:'identity-member@example.invalid',roles:['member'],membership:true,expect:{role:'member',roles:['member'],membership:'Monthly'}},
 ];
 for(const c of cases){
  const id=await userWith(c.email,c.roles,c.membership);
  const found=await model.findById(id),profile=await model.profile(id);
  assert.ok(found&&profile,c.email);
  const pick=(u:any)=>({role:u.role,roles:u.roles,membership:u.membership});
  assert.deepEqual(pick(found),c.expect,c.email);
  assert.deepEqual(pick(profile.user),c.expect,c.email);
 }
});
