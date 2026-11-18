import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { loadReport } from '../../src/reports/service.js';
import { PaymentRepository } from '../../src/models/staff/payments.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_report_categories_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('equipment and training income is labelled in the revenue report as on the staff Payments screen', async () => {
  const user = (await pool.query(`SELECT userid FROM "user" ORDER BY userid LIMIT 1`)).rows[0].userid;
  const payment = async (price: number, note = '') => (await pool.query(`INSERT INTO payment(userid,price,paymentstatus,paymentdate,method,note)
    VALUES($1,$2,'paid',TIMESTAMP '2030-01-02 15:00','card',$3) RETURNING paymentid`, [user, price, note])).rows[0].paymentid as number;
  const machine = (await pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
    VALUES('Category laser','available',7,false,'Report test') RETURNING equipmentid`)).rows[0].equipmentid;
  const equipmentPayment = await payment(14);
  await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status,payment_id)
    VALUES($1,$2,'Report test',TIMESTAMP '2030-01-03 15:00',TIMESTAMP '2030-01-03 17:00','confirmed',$3)`, [user, machine, equipmentPayment]);
  const room = (await pool.query('SELECT roomid FROM room LIMIT 1')).rows[0].roomid;
  const cert = (await pool.query('SELECT certid FROM certifications LIMIT 1')).rows[0].certid;
  const slot = (await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'Report test',TIMESTAMP '2030-01-04 15:00',TIMESTAMP '2030-01-04 16:00','confirmed') RETURNING reservationid`, [user, room])).rows[0].reservationid;
  const course = (await pool.query(`INSERT INTO app_training_class(title,certification_id,instructor_id,reservation_id,capacity,created_by)
    VALUES('Category safety class',$1,$2,$3,15,$2) RETURNING id`, [cert, user, slot])).rows[0].id;
  const trainingPayment = await payment(20);
  await pool.query('INSERT INTO app_training_enrollment(class_id,user_id,training_fee_cents,payment_id) VALUES($1,$2,2000,$3)', [course, user, trainingPayment]);
  // A fee whose enrollment link is gone still carries its description, as on the Payments screen.
  await payment(5, 'Equipment booking: legacy drill press');
  // An online day-pass payment refunded instead of issued has no pass; its checkout names the plan.
  const unissuedPayment = (await pool.query(`INSERT INTO payment(userid,price,paymentstatus,paymentdate,method,note)
    VALUES($1,15,'refunded',TIMESTAMP '2030-01-02 15:00','card','Online day pass (not issued)') RETURNING paymentid`, [user])).rows[0].paymentid as number;
  await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,status,payment_id)
    SELECT $3,$1,tierid,DATE '2030-01-01',jsonb_build_object('name','Category day pass'),1500,'cancelled',$2
    FROM membership_tiers WHERE kind='day_pass' LIMIT 1`, [user, unissuedPayment, randomUUID()]);

  const ledger = new Map((await new PaymentRepository(pool).payments(null)).map(p => [p.id, p.planName]));
  assert.equal(ledger.get(equipmentPayment), 'Equipment: Category laser');
  assert.equal(ledger.get(trainingPayment), 'Training class: Category safety class');
  assert.equal(ledger.get(unissuedPayment), 'Category day pass');

  const report = await loadReport(pool, 'America/New_York', { from: '2030-01-02', to: '2030-01-02', period: 'daily' });
  const categories = report.revenue.map(r => r.category);
  for (const label of ['Equipment: Category laser', 'Training class: Category safety class', 'Equipment booking: legacy drill press', 'Category day pass'])
    assert.ok(categories.includes(label), `${label} in ${JSON.stringify(categories)}`);
  assert.ok(!categories.includes('Unclassified payment'), JSON.stringify(report.revenue));
  assert.equal(report.revenue.reduce((sum, r) => sum + Number(r.gross), 0), 54, 'each payment counted once');
  assert.equal(Number(report.revenue.find(r => r.category === 'Category day pass')?.refunds), 15, 'the refund is reported');
});
