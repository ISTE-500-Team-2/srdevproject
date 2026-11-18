import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { loadReport } from '../../src/reports/service.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_report_class_fill_' + randomBytes(5).toString('hex') + '_mvc_test';
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

test('a legacy class larger than 15 seats never reports over 100% full', async () => {
  const user = (await pool.query(`SELECT userid FROM "user" ORDER BY userid LIMIT 1`)).rows[0].userid;
  const room = (await pool.query('SELECT roomid FROM room LIMIT 1')).rows[0].roomid;
  const course = async (title: string, capacity: number, hour: number, people: number) => {
    const slot = (await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
      VALUES($1,$2,'Report test',TIMESTAMP '2030-02-05 00:00'+$3*interval '1 hour',TIMESTAMP '2030-02-05 00:30'+$3*interval '1 hour','confirmed')
      RETURNING reservationid`, [user, room, hour])).rows[0].reservationid;
    const id = (await pool.query(`INSERT INTO app_training_class(title,instructor_id,reservation_id,capacity,created_by)
      VALUES($1,$2,$3,$4,$2) RETURNING id`, [title, user, slot, capacity])).rows[0].id;
    await pool.query(`WITH people AS (
        INSERT INTO "user"(firstname,lastname,email,password,phone,status)
        SELECT 'Seat',n::text,'fill-'||$1::int||'-'||n||'@example.invalid','x','0000000000','active' FROM generate_series(1,$2::int) n RETURNING userid)
      INSERT INTO app_training_enrollment(class_id,user_id) SELECT $1::int,userid FROM people`, [id, people]);
    return id as number;
  };
  // Classes created before the 15-seat cap kept their larger capacity.
  await pool.query('ALTER TABLE app_training_class DISABLE TRIGGER app_class_capacity_15');
  const overfull = await course('Legacy big class', 20, 14, 18);
  const legacy = await course('Legacy half class', 20, 16, 12);
  await pool.query('ALTER TABLE app_training_class ENABLE TRIGGER app_class_capacity_15');
  const current = await course('Current class', 10, 18, 4);

  const report = await loadReport(pool, 'America/New_York', { from: '2030-02-05', to: '2030-02-05', period: 'daily' });
  const row = (id: number) => report.classes.find(c => c.id === id)!;
  // Enrollment stops at 15, but the 18 people already enrolled keep their seats.
  assert.deepEqual([row(overfull).enrolled, row(overfull).capacity, Number(row(overfull).filledPercent)], [18, 18, 100]);
  assert.deepEqual([row(legacy).enrolled, row(legacy).capacity, Number(row(legacy).filledPercent)], [12, 15, 80]);
  assert.deepEqual([row(current).enrolled, row(current).capacity, Number(row(current).filledPercent)], [4, 10, 40]);
  assert.deepEqual(report.classes.map(c => c.id), [overfull, legacy, current], 'classes stay in start-time order');
  for (const c of report.classes) assert.ok(c.enrolled <= c.capacity && Number(c.filledPercent) <= 100, JSON.stringify(c));
});
