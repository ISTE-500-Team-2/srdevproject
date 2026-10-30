import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { membershipTrends } from '../../src/membershipReports.js';

const database='arbor_report_scale_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});let created=false;
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

test('500 members and overlapping renewals remain distinct across the 25-hour DST day',async()=>{
  const from=new Date('2026-10-31T04:00:00Z'),to=new Date('2026-11-02T05:00:00Z');
  const baseline=await membershipTrends(pool,from,to,'America/New_York','day');
  assert.deepEqual(baseline.map(row=>row.period),['2026-10-31','2026-11-01']);
  const ids=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,phone,password,status,email_confirmed)
    SELECT 'Scale','Fixture','report-scale-'||g||'@example.invalid','0000000000','not-a-login','active',true
    FROM generate_series(1,500) g RETURNING userid`)).rows.map(row=>row.userid);
  await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
    SELECT id,(SELECT tierid FROM membership_tiers ORDER BY tierid LIMIT 1),'2026-10-31 23:30:00','2026-11-01 06:30:00','active'
    FROM unnest($1::int[]) id`,[ids]);
  await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
    SELECT id,(SELECT tierid FROM membership_tiers ORDER BY tierid LIMIT 1),'2026-11-01 06:30:00','2026-11-03 05:00:00','active'
    FROM unnest($1::int[]) id`,[ids.slice(0,250)]);
  const actual=await membershipTrends(pool,from,to,'America/New_York','day');
  assert.deepEqual(actual.map((row,i)=>({new:row.newMembers-baseline[i].newMembers,
    active:row.activeMembers-baseline[i].activeMembers,expiring:row.expiringMembers-baseline[i].expiringMembers})),
    [{new:500,active:500,expiring:0},{new:0,active:500,expiring:250}]);
});
