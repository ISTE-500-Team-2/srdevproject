import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserBridge } from '../helpers/browserBridge.js';

test('today report counts everyone and returns the latest distinct visitors before limiting', async () => {
  const bridge = await createBrowserBridge();
  try {
    await bridge.fetch('/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
    await bridge.pool.query('DELETE FROM check_in');
    const today = (await bridge.pool.query("SELECT to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day")).rows[0].day;
    const report = async () => {
      const response = await bridge.fetch(`/api/admin/reports?from=${today}&to=${today}&period=daily`);
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const empty = await report();
    assert.equal(empty.checkedInTodayCount, 0);
    assert.deepEqual(empty.checkedInToday, []);
    const { rows } = await bridge.pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
      SELECT 'Review','Visitor '||g,'recent-visitor-'||g||'@example.invalid','x','0000000000','active'
      FROM generate_series(1,51) g RETURNING userid`);
    const ids: number[] = rows.map(row => row.userid).sort((a, b) => a - b);
    await bridge.pool.query(`INSERT INTO check_in(userid,location,checkintime,status,statusdesc)
      SELECT id,'Studio',NOW() AT TIME ZONE 'UTC'-interval '1 microsecond'*(52-ord),'approved','Authenticated NFC eligibility decision'
      FROM unnest($1::int[]) WITH ORDINALITY t(id,ord)`, [ids]);
    let data = await report();
    assert.equal(data.checkedInTodayCount, 51);
    assert.equal(data.checkedInToday.length, 50);
    assert.deepEqual(data.checkedInToday.map((person: { userId: number }) => person.userId), [...ids].reverse().slice(0, 50));
    // An existing visitor checking in again moves to the front without adding a person.
    await bridge.pool.query(`INSERT INTO check_in(userid,location,checkintime,status,statusdesc)
      VALUES($1,'Second visit',NOW() AT TIME ZONE 'UTC','approved','Eligibility verified by member portal'),
        ($2,'Rejected',NOW() AT TIME ZONE 'UTC','denied','Not eligible'),
        ($2,'Yesterday',(NOW()-interval '1 day') AT TIME ZONE 'UTC','approved','Prior visit')`, [ids[0], ids[1]]);
    data = await report();
    assert.equal(data.checkedInTodayCount, 51);
    assert.equal(data.checkedInToday[0].userId, ids[0]);
    assert.equal(data.checkedInToday[0].location, 'Second visit');
    assert.equal(data.checkedInToday[0].method, 'portal');
    assert.equal(new Set(data.checkedInToday.map((person: { userId: number }) => person.userId)).size, 50);
    assert.ok(data.checkedInToday.every((person: { location: string }) => !['Rejected', 'Yesterday'].includes(person.location)));
  } finally {
    await bridge.close();
  }
});
