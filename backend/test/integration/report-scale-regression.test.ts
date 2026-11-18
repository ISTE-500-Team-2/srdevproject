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

interface PlanNode {'Total Cost':number;'Subplan Name'?:string;Plans?:PlanNode[]}
/** The planner's estimate for a 30-day daily membership report. */
async function reportPlan():Promise<PlanNode>{
  let statement='',parameters:unknown[]=[];
  await membershipTrends({query:async(text,values)=>{statement=text;parameters=values??[];return {rows:[],rowCount:0};}},
    new Date('2026-10-01T04:00:00Z'),new Date('2026-10-31T04:00:00Z'),'America/New_York','day');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SET LOCAL jit=on');
    await client.query('SET LOCAL jit_above_cost=100000');
    const plan=(await client.query('EXPLAIN (FORMAT JSON) '+statement,parameters)).rows[0]['QUERY PLAN'][0];
    await client.query('ROLLBACK');
    return plan.Plan;
  }finally{client.release();}
}

test('sparse membership reports avoid repeated cancellation scans that trigger JIT',async()=>{
  assert.ok((await reportPlan())['Total Cost']<100000,'Sparse report plan must remain below the standard JIT threshold');
});

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
  assert.deepEqual(actual.map((row,i)=>({new:row.newMembers-baseline[i]!.newMembers,
    active:row.activeMembers-baseline[i]!.activeMembers,expiring:row.expiringMembers-baseline[i]!.expiringMembers})),
    [{new:500,active:500,expiring:0},{new:0,active:500,expiring:250}]);
});

test('two years of card renewals do not inflate the cost of reading each membership once',async()=>{
  // 300 card subscribers with 20 paid monthly periods each, all ended before the windows above.
  const tier='(SELECT tierid FROM membership_tiers ORDER BY tierid LIMIT 1)';
  await pool.query(`WITH members AS (
      INSERT INTO "user"(firstname,lastname,email,phone,password,status,email_confirmed)
      SELECT 'Card','Fixture','report-card-'||g||'@example.invalid','0000000000','not-a-login','active',true
      FROM generate_series(1,300) g RETURNING userid
    ), billing AS (
      INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status)
      SELECT md5('report-card-'||userid)::uuid,userid,${tier},'{}',5000,'active' FROM members RETURNING id,userid
    ), periods AS (
      INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
      SELECT b.userid,${tier},TIMESTAMP '2024-07-01'+m*INTERVAL '1 month',TIMESTAMP '2024-07-01'+(m+1)*INTERVAL '1 month','active'
      FROM billing b CROSS JOIN generate_series(0,19) m RETURNING membershipid,userid,startdate,end_date
    ), payments AS (
      INSERT INTO payment(userid,membershipid,price,paymentstatus,paymentdate,method)
      SELECT userid,membershipid,50,'paid',startdate,'card' FROM periods RETURNING paymentid,membershipid
    ) INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end)
    SELECT 'in_report_scale_'||p.paymentid,b.id,m.membershipid,p.paymentid,m.startdate AT TIME ZONE 'UTC',m.end_date AT TIME ZONE 'UTC'
    FROM payments p JOIN periods m USING(membershipid) JOIN billing b USING(userid)`);
  await pool.query('ANALYZE "user",user_membership,payment,app_membership_billing,app_membership_invoice');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM app_membership_invoice WHERE id LIKE 'in_report_scale_%'")).rows[0].n,6000);
  // Checking renewal per membership with a correlated scan of the invoices is costed near a million
  // here, which alone turns on JIT; one hashed set of renewing periods costs a few hundred.
  const windows=(await reportPlan()).Plans?.find(node=>node['Subplan Name']==='CTE membership_windows');
  assert.ok(windows,'the report reads memberships once, in its own step');
  assert.ok(windows['Total Cost']<10000,`membership step cost ${windows['Total Cost']}`);
});
