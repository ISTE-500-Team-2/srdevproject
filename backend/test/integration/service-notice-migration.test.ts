import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {StaffModel} from '../../src/models/StaffModel.js';
import {migrate} from '../../src/scripts/migrate.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';

test('FR-032: upgrading keeps earlier notices\' reach and their "what was fixed" message', async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  const database = 'arbor_notices_' + randomBytes(6).toString('hex') + '_mvc_test';
  const admin = new Pool(), pool = new Pool({database});
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await initializeDemo(pool);
    // Put the database back to how it was before this migration.
    await pool.query(`DROP INDEX app_service_notice_opened; DROP INDEX app_service_notice_reader_opened;
      ALTER TABLE app_service_notice DROP COLUMN recipients, DROP COLUMN resolution;
      DELETE FROM app_migration WHERE name='038_service_notice_detail.sql'`);
    const users = (await pool.query<{userid: number}>('SELECT userid FROM "user" ORDER BY userid LIMIT 3')).rows.map((r) => r.userid);
    const [actor] = users;
    const notice = async (resolved: boolean) => (await pool.query<{id: number}>(
      `INSERT INTO app_service_notice(source,summary,opened_by,resolved_at,resolved_by) VALUES('staff','The laser cutter is down.',$1,$2,$3) RETURNING id`,
      [actor, resolved ? new Date() : null, resolved ? actor : null])).rows[0]!.id;
    const fixed = await notice(true), open = await notice(false);
    // Three emails queued for the fixed notice, one of them to someone who opted out.
    for (const [i, status] of (['accepted', 'pending', 'suppressed'] as const).entries())
      await pool.query(`INSERT INTO app_notification_outbox(userid,kind,dedupe_key,payload,due_at,deadline_at,status,counts_for_sla)
        VALUES($1,'system_issue',$2,'{}'::jsonb,NOW(),NOW(),$3,false)`, [users[i % users.length], `system_issue:${fixed}:${i}`, status]);
    // A key that isn't a notice's must be skipped, not abort the upgrade.
    await pool.query(`INSERT INTO app_notification_outbox(userid,kind,dedupe_key,payload,due_at,deadline_at,status,counts_for_sla)
      VALUES($1,'system_issue','system_issue:99999999999999999999999:x','{}'::jsonb,NOW(),NOW(),'accepted',false)`, [actor]);
    // An emailed restore notice must not count toward the original reach.
    await pool.query(`INSERT INTO app_notification_outbox(userid,kind,dedupe_key,payload,due_at,deadline_at,status,counts_for_sla)
      VALUES($1,'service_restored',$2,'{}'::jsonb,NOW(),NOW(),'accepted',false)`, [actor, `service_restored:${fixed}:${actor}`]);
    await new StaffModel(pool).audit(actor!, null, 'service_notice.resolved', 'app_service_notice', fixed, 'Fan replaced, cutting again.', null, null);

    await migrate(pool);

    const rows = (await pool.query(`SELECT id,recipients,resolution FROM app_service_notice WHERE id=ANY($1) ORDER BY id`, [[fixed, open]])).rows;
    assert.deepEqual(rows, [
      {id: fixed, recipients: 2, resolution: 'Fan replaced, cutting again.'},
      {id: open, recipients: 0, resolution: null},
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});
