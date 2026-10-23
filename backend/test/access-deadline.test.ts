import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { accessTransaction, AccessDeadlineError } from '../src/services/AccessTransaction.js';

function fixture() {
  const queries: string[] = [], releases: boolean[] = [];
  const client = {
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
    release: (destroy = false) => { releases.push(destroy); },
  } as unknown as PoolClient;
  return { client, queries, releases, pool: { connect: async () => client } as unknown as Pool };
}

test('access transaction commits successful work and rolls back failed work', async () => {
  const f = fixture();
  assert.equal(await accessTransaction(f.pool, async db => { await db.query('SELECT 1'); return 42; }), 42);
  assert.equal(f.queries.at(-1), 'COMMIT');
  assert.deepEqual(f.releases, [false]);
  const g = fixture();
  await assert.rejects(accessTransaction(g.pool, async () => { throw Error('failed'); }), /failed/);
  assert.equal(g.queries.at(-1), 'ROLLBACK');
});

test('deadline covers pool wait and releases a connection that arrives late', async () => {
  const f = fixture();
  let connect!: (client: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { connect = resolve; }) } as unknown as Pool;
  await assert.rejects(accessTransaction(pool, async () => assert.fail('must not execute'), 20), AccessDeadlineError);
  connect(f.client);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.releases, [false]);
});

test('deadline destroys in-flight transaction and blocks later queries and commit', async () => {
  const f = fixture();
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  await assert.rejects(accessTransaction(f.pool, async db => {
    await paused;
    await db.query('INSERT check_in');
  }, 20), AccessDeadlineError);
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.releases, [true]);
  assert.ok(!f.queries.includes('INSERT check_in'));
  assert.ok(!f.queries.includes('COMMIT'));
});
