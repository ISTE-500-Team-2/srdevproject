import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { loadFixture } from '../load/fixture.js';
import { ReaderRegistry } from '../../src/readerRegistry.js';
import { checkReaderHealth } from '../../src/serviceNotices.js';

let fixture: Awaited<ReturnType<typeof loadFixture>>;
before(async () => { fixture = await loadFixture(10, 10, 60); });
after(async () => { await fixture?.close(); });
async function scan(index = 2, eventId = randomUUID(), equipment = false, heartbeat = false, renewal = false) {
  const member = fixture.members[index]!;
  const body = JSON.stringify({ uid: member.uid, eventId, checkIn: !renewal, renewal, ...(heartbeat ? { action: 'heartbeat' } : {}) });
  const stamp = String(Date.now());
  const response = await fetch(fixture.origin + '/api/devices/decision', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Reader-ID': equipment ? member.readerId : 'load-entrance', 'X-Reader-Timestamp': stamp,
      'X-Reader-Signature': createHmac('sha256', fixture.secret).update(stamp + '\n' + body).digest('hex') }, body,
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() as any };
}

test('a shared reader metadata lock does not serialize ordinary signed check-ins', async () => {
  const holder = await fixture.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT id FROM app_access_reader WHERE id='load-entrance' FOR SHARE");
    const response = await scan();
    assert.equal(response.status, 200);
    assert.equal(response.body.data.allowed, true, JSON.stringify(response.body));
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  // Legacy readers can signal presence with taps, without sending heartbeats.
  const listed = await new ReaderRegistry(fixture.pool).list();
  assert.equal(listed.find(r => r.id === 'load-entrance')?.online, true);
});

test('simultaneous replay produces one decision/check-in and a 409 for the duplicate', async () => {
  const eventId = randomUUID();
  const before = (await fixture.pool.query('SELECT count(*)::int n FROM check_in')).rows[0].n;
  const responses = await Promise.all([scan(3, eventId), scan(3, eventId)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(responses.find(r => r.status === 409)?.body.error.code, 'REPLAYED_EVENT');
  assert.equal((await fixture.pool.query('SELECT count(*)::int n FROM app_device_access_event WHERE request_id=$1', [eventId])).rows[0].n, 1);
  assert.equal((await fixture.pool.query('SELECT count(*)::int n FROM check_in')).rows[0].n, before + 1);
});

test('tap-only reader presence prevents false outage notices and resolves a prior outage', async () => {
  await fixture.pool.query("UPDATE app_access_reader SET last_seen_at=NOW()-interval '10 minutes' WHERE id='load-entrance'");
  assert.equal((await scan()).body.data.allowed, true);
  await checkReaderHealth(fixture.pool);
  assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM app_service_notice WHERE reader_id='load-entrance' AND resolved_at IS NULL")).rows[0].n, 0);
  const notice = (await fixture.pool.query("INSERT INTO app_service_notice(source,reader_id,summary) VALUES('reader','load-entrance','Synthetic prior outage') RETURNING id")).rows[0].id;
  await checkReaderHealth(fixture.pool);
  assert.ok((await fixture.pool.query('SELECT resolved_at FROM app_service_notice WHERE id=$1', [notice])).rows[0].resolved_at);
});

test('authenticated renewals preserve presence without a tap or heartbeat and add no check-in', async () => {
  const member = fixture.members[5]!;
  await fixture.pool.query("UPDATE app_access_reader SET last_seen_at=NOW()-interval '10 minutes' WHERE id=$1", [member.readerId]);
  const before = (await fixture.pool.query('SELECT count(*)::int n FROM check_in')).rows[0].n;
  assert.equal((await scan(5, randomUUID(), true, false, true)).body.data.allowed, true);
  const listed = await new ReaderRegistry(fixture.pool).list();
  assert.equal(listed.find(r => r.id === member.readerId)?.online, true);
  assert.equal((await fixture.pool.query('SELECT count(*)::int n FROM check_in')).rows[0].n, before);
  await checkReaderHealth(fixture.pool);
  assert.equal((await fixture.pool.query('SELECT count(*)::int n FROM app_service_notice WHERE reader_id=$1 AND resolved_at IS NULL', [member.readerId])).rows[0].n, 0);
});

test('an exclusive reader edit still orders check-ins after a disable, and heartbeats retain presence', async () => {
  const holder = await fixture.pool.connect();
  let pending: ReturnType<typeof scan> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query("UPDATE app_access_reader SET enabled=false WHERE id='load-entrance'");
    pending = scan();
    await holder.query('COMMIT');
    const response = await pending;
    assert.equal(response.body.data.allowed, false);
    assert.equal(response.body.data.reason, 'READER_DISABLED');
    const heartbeat = await scan(2, randomUUID(), false, true);
    assert.equal(heartbeat.body.data.reason, 'HEARTBEAT');
    assert.ok((await fixture.pool.query("SELECT last_seen_at FROM app_access_reader WHERE id='load-entrance'")).rows[0].last_seen_at);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await pending;
    await fixture.pool.query("UPDATE app_access_reader SET enabled=true WHERE id='load-entrance'");
  }
});

test('bursts never reuse an earlier grant after training or facility signatures are revoked', async () => {
  const member = fixture.members[2]!;
  assert.equal((await scan(2, randomUUID(), true)).body.data.allowed, true);
  try {
    await fixture.pool.query("UPDATE user_certifications SET status='revoked' WHERE userid=$1", [member.id]);
    const denied = await Promise.all(Array.from({ length: 10 }, () => scan(2, randomUUID(), true)));
    assert.ok(denied.every(r => r.body.data.allowed === false && r.body.data.reason === 'CERTIFICATION_REQUIRED'));
    await fixture.pool.query("UPDATE user_certifications SET status='active' WHERE userid=$1", [member.id]);
    await fixture.pool.query("UPDATE user_waiver SET approval=false WHERE userid=$1 AND waiverid IN(SELECT waiverid FROM waiver WHERE policy_scope='facility')", [member.id]);
    const unsigned = await Promise.all(Array.from({ length: 10 }, () => scan(2)));
    assert.ok(unsigned.every(r => r.body.data.allowed === false && r.body.data.reason === 'WAIVER_REQUIRED'));
  } finally {
    await fixture.pool.query("UPDATE user_certifications SET status='active' WHERE userid=$1", [member.id]);
    await fixture.pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1', [member.id]);
  }
});

test('scheduled resource access denies early and ended windows while permitting the active window', async () => {
  const member = fixture.members[4]!;
  const setWindow = (start: string, end: string) => fixture.pool.query(`UPDATE reservation
    SET starttime=(NOW()+$2::interval) AT TIME ZONE 'UTC',endtime=(NOW()+$3::interval) AT TIME ZONE 'UTC'
    WHERE userid=$1 AND equipmentid IS NOT NULL`, [member.id, start, end]);
  await setWindow('1 hour', '2 hours');
  assert.equal((await scan(4, randomUUID(), true)).body.data.reason, 'RESERVATION_REQUIRED');
  await setWindow('-1 minute', '1 hour');
  assert.equal((await scan(4, randomUUID(), true)).body.data.allowed, true);
  await setWindow('-2 hours', '-1 hour');
  assert.equal((await scan(4, randomUUID(), true)).body.data.reason, 'RESERVATION_REQUIRED');
});
