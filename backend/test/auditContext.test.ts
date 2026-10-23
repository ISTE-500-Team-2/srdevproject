import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { auditContext, auditedPool } from '../src/auditContext.js';

test('concurrent audit queries isolate identity and release connections after commit', async () => {
  const connections: { statements: [string, unknown[]?][]; released: boolean }[] = [];
  const pool = auditedPool({ connect: async () => {
    const state = { statements: [] as [string, unknown[]?][], released: false };
    connections.push(state);
    return {
      query: async (sql: string, values?: unknown[]) => { state.statements.push([sql, values]); return {rows: []}; },
      release: () => { state.released = true; },
    };
  } } as unknown as Pool);
  await Promise.all([11,22].map(actorId => auditContext.run({actorId}, () => pool.query('UPDATE example SET active=true'))));
  assert.deepEqual(connections.map(c => c.statements[1][1]), [['11'],['22']]);
  for (const c of connections) {
    assert.equal(c.statements.at(-1)![0], 'COMMIT');
    assert.equal(c.released, true);
  }
});

test('failed mutations roll back audit transaction and release the connection', async () => {
  const statements: string[] = [];
  let released = false;
  const pool = auditedPool({ connect: async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql === 'mutation') throw new Error('write failed');
      return {rows: []};
    },
    release: () => { released = true; },
  }) } as unknown as Pool);
  await assert.rejects(pool.query('mutation'), /write failed/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});
