import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { createPool } from '../../src/db.js';

// A database restart or a dropped connection must not take the website down with it.
test('a terminated idle connection is logged and replaced, and the pool keeps serving',async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PG required');
  const pool=createPool(),admin=new Pool();
  const logged=mock.method(console,'error',()=>{});
  try{
    const {pid}=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0];
    const lost=once(pool,'error');
    await admin.query('SELECT pg_terminate_backend($1)',[pid]);
    await lost;
    assert.ok(logged.mock.calls.some(call=>call.arguments[0]==='Idle database connection lost'));
    const again=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0];
    assert.notEqual(again.pid,pid);
  }finally{logged.mock.restore();await pool.end();await admin.end();}
});
