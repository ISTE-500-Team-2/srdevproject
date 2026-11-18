import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { createPool, transaction } from '../../src/db.js';

// A database restart or a dropped connection must not take the website down with it. The tests
// wait for the connection's 'end' with a plain listener: events.once (or any 'error' listener
// here) would hide a missing listener in createPool.
const ended = (client: EventEmitter) => new Promise(resolve => client.once('end', resolve));
const lostLogs = (logged: { mock: { calls: { arguments: unknown[] }[] } }) =>
  logged.mock.calls.filter(call => call.arguments[0] === 'Database connection lost').map(call => call.arguments[1]);

test('a terminated idle connection is logged and replaced, and the pool keeps serving',async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PG required');
  const pool=createPool(),admin=new Pool();
  const logged=mock.method(console,'error',()=>{});
  try{
    const client=await pool.connect();
    const {pid}=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0];
    client.release();
    const closed=ended(client);
    await admin.query('SELECT pg_terminate_backend($1)',[pid]);
    await closed;
    assert.deepEqual(lostLogs(logged),[{code:'57P01'}]);
    const again=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0];
    assert.notEqual(again.pid,pid);
  }finally{logged.mock.restore();await pool.end();await admin.end();}
});

test('a connection dropped mid-transaction fails only that work, and the pool keeps serving',async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PG required');
  const pool=createPool(),admin=new Pool();
  const logged=mock.method(console,'error',()=>{});
  let pid=0;
  try{
    // A checked-out client has no pool listener: before the fix this ended the process.
    await assert.rejects(transaction(pool,async client=>{
      const closed=ended(client);
      pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)',[pid]);
      await closed;
      await client.query('SELECT 1');
    }));
    assert.deepEqual(lostLogs(logged),[{code:'57P01'}]);
    const again=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0];
    assert.notEqual(again.pid,pid);
    assert.equal(pool.totalCount,1);
  }finally{logged.mock.restore();await pool.end();await admin.end();}
});
