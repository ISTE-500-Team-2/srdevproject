import assert from 'node:assert/strict';
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
