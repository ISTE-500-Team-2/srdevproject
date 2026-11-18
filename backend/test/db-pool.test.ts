import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createPool} from '../src/db.js';

test('optional pool sizing keeps the existing default and bounds deployment connection budgets',async()=>{
  const previous=process.env.ARBOR_DB_POOL_MAX;
  try{
    delete process.env.ARBOR_DB_POOL_MAX;
    const standard=createPool();assert.equal(standard.options.max,10);await standard.end();
    for(const max of ['1','20','30']){
      process.env.ARBOR_DB_POOL_MAX=max;const pool=createPool();assert.equal(pool.options.max,Number(max));await pool.end();
    }
    for(const invalid of ['','0','-1','1.5','31','999','NaN','Infinity','0x14']){
      process.env.ARBOR_DB_POOL_MAX=invalid;assert.throws(()=>createPool(),/ARBOR_DB_POOL_MAX/);
    }
  }finally{if(previous===undefined)delete process.env.ARBOR_DB_POOL_MAX;else process.env.ARBOR_DB_POOL_MAX=previous;}
});

test('a pooled connection the server drops is logged once instead of crashing the process',async()=>{
  const pool=createPool();
  const logged:unknown[][]=[];
  const original=console.error;
  console.error=(...args:unknown[])=>{logged.push(args);};
  try{
    // EventEmitter throws an 'error' event that has no listener, which would end the process.
    // A checked-out client has no pool listener, so each client needs its own, for life.
    const client=new EventEmitter();
    pool.emit('connect',client);
    const terminated=Object.assign(new Error('terminating connection due to administrator command'),{code:'57P01'});
    assert.doesNotThrow(()=>client.emit('error',terminated));
    assert.doesNotThrow(()=>client.emit('error',new Error('Connection terminated unexpectedly')));
    // pg-pool repeats an idle client's error on the pool.
    assert.doesNotThrow(()=>pool.emit('error',terminated,client));
    assert.deepEqual(logged,[['Database connection lost',{code:'57P01'}]]);
  }finally{console.error=original;await pool.end();}
});
