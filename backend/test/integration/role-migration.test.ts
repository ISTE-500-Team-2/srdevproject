import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {SessionModel} from '../../src/models/SessionModel.js';
import {migrate} from '../../src/scripts/migrate.js';

test('role migration preserves legacy accounts/assignments/denies and backfills a safe primary/student modifier',async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw new Error('Explicit isolated PostgreSQL settings required');
 const database='arbor_roles_'+randomBytes(6).toString('hex')+'_mvc_test';
 const admin=new Pool(),pool=new Pool({database});let created=false;
 try {
  await admin.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  const legacyId=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  const sessions=new SessionModel(pool,new Uint8Array(randomBytes(32)));
  const legacySession=await sessions.create(legacyId,true);
  const sessionsBefore=(await pool.query('SELECT * FROM app_session ORDER BY token_hash')).rows;
  const refreshBefore=(await pool.query('SELECT * FROM app_refresh_family ORDER BY id')).rows;
  // Reconstruct the old column layout while retaining real user and role data.
  await pool.query('ALTER TABLE "user" DROP COLUMN primary_role,DROP COLUMN is_student');
  await pool.query("DELETE FROM app_migration WHERE name='010_role_assignments.sql'");
  await pool.query(`INSERT INTO user_role(userid,roleid,assignedat) SELECT u.userid,r.roleid,NOW() FROM "user" u CROSS JOIN role r WHERE u.email='demo.member@collaboratory.invalid' AND r.role='student'`);
  await pool.query(`UPDATE role_permission SET isallowed=false WHERE roleid=(SELECT roleid FROM role WHERE role='member') AND resourcename='equipment'`);
  const before=(await pool.query('SELECT userid,email,password,status FROM "user" ORDER BY userid')).rows;
  const assigned=(await pool.query('SELECT * FROM user_role ORDER BY userid,roleid')).rows;
  await migrate(pool);await migrate(pool);
  assert.deepEqual((await pool.query('SELECT * FROM app_session ORDER BY token_hash')).rows,sessionsBefore);
  assert.deepEqual((await pool.query('SELECT * FROM app_refresh_family ORDER BY id')).rows,refreshBefore);
  assert.equal((await sessions.find(legacySession.token))?.userId,legacyId);
  const rotated=await sessions.rotate(legacySession.refreshToken,legacySession.csrfToken);
  assert.equal(rotated?.user.id,legacyId,'existing remembered session can refresh after migration');
  assert.deepEqual((await pool.query('SELECT userid,email,password,status FROM "user" ORDER BY userid')).rows,before);
  assert.deepEqual((await pool.query('SELECT * FROM user_role ORDER BY userid,roleid')).rows,assigned);
  assert.equal((await pool.query(`SELECT primary_role FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].primary_role,'admin');
  assert.deepEqual((await pool.query(`SELECT primary_role,is_student FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0],{primary_role:'member',is_student:true});
  assert.equal((await pool.query(`SELECT isallowed FROM role_permission WHERE roleid=(SELECT roleid FROM role WHERE role='member') AND resourcename='equipment'`)).rows[0].isallowed,false);
 } finally {await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();}
});
