import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {Pool} from 'pg';
import {migrate,prepareAuditMigration,repositoryRoot} from '../../src/scripts/migrate.js';
import {transaction} from '../../src/db.js';
import {StaffModel} from '../../src/models/StaffModel.js';

test('combined migrations upgrade the previous schema without rewriting paid membership, payment, signature or audit history',async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  const database='arbor_catalog_upgrade_'+randomBytes(6).toString('hex')+'_mvc_test';
  const owner=new Pool(),pool=new Pool({database});let created=false;
  try{
    await owner.query(`CREATE DATABASE "${database}"`);created=true;
    await transaction(pool,async db=>{
      await db.query(await readFile(path.join(repositoryRoot,'ddl/collaboratory-db-create.sql'),'utf8'));
      await db.query('CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const dir=path.join(repositoryRoot,'database/migrations');
      for(const name of (await readdir(dir)).filter(n=>/^\d+.*\.sql$/.test(n)&&parseInt(n)<20).sort()){
        const sql=await readFile(path.join(dir,name),'utf8');
        await prepareAuditMigration(db,name);await db.query(sql);
        await db.query('INSERT INTO app_migration(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
      }
    });
    const user=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status) VALUES('Upgrade','Fixture','upgrade@example.invalid','not-a-login','0000000000','active') RETURNING userid`)).rows[0].userid;
    const model=new StaffModel(pool);
    const plan=await model.createPlan({name:'Historical Basic Monthly',kind:'membership',price:'19.99',months:1,benefits:'Accepted legacy terms',active:true});
    const membership=await model.createMembership(user,plan,new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+29*86400000),user,'Existing paid member');
    await model.createPayment(user,membership,'19.99','paid','cash','OLD-RECEIPT','Historical fixture payment',user);
    const waiver=(await pool.query("INSERT INTO waiver(name,version,description,isactive,required) VALUES('Existing policy','1','Preserve original text',true,true) RETURNING waiverid")).rows[0].waiverid;
    await pool.query('INSERT INTO user_waiver(userid,waiverid,approval,signdate) VALUES($1,$2,true,now())',[user,waiver]);
    await model.audit(user,user,'fixture.existing','membership',membership,'Historical fixture audit',null,{price:'19.99'});
    async function history(){return {
      memberships:(await pool.query('SELECT * FROM user_membership ORDER BY membershipid')).rows,
      payments:(await pool.query('SELECT * FROM payment ORDER BY paymentid')).rows,
      signatures:(await pool.query('SELECT * FROM user_waiver ORDER BY userwaiverid')).rows,
      audit:(await pool.query("SELECT * FROM app_staff_audit WHERE action='fixture.existing'")).rows,
    };}
    const before=await history(),checksums=(await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    await migrate(pool);
    assert.deepEqual(await history(),before);
    for(const entry of checksums)assert.equal((await pool.query('SELECT checksum FROM app_migration WHERE name=$1',[entry.name])).rows[0].checksum,entry.checksum);
    assert.equal((await model.plan(plan.id))!.active,false);
    assert.deepEqual((await model.plans(true)).map(p=>[p.kind,p.price]).sort(),[['day_pass','25.00'],['membership','95.00']]);
    const terms=(await pool.query("SELECT waiverid FROM waiver WHERE name='Terms of Service' AND isactive AND required")).rows;
    assert.equal(terms.length,1);
    assert.equal((await pool.query('SELECT * FROM user_waiver WHERE userid=$1 AND waiverid=$2',[user,terms[0].waiverid])).rowCount,0,'A migration must not sign new terms for an existing member');
    const after=(await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    await migrate(pool);assert.deepEqual(await history(),before);
    assert.deepEqual((await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows,after);
    assert.deepEqual((await model.plans(true)).map(p=>[p.kind,p.price]).sort(),[['day_pass','25.00'],['membership','95.00']]);
  }finally{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();}
});
