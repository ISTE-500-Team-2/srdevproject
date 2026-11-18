import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool} from 'pg';
import {ProviderGate,providerGate} from '../src/billing/providerGate.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('runs at most `limit` jobs at once and hands each freed slot to the next waiter in order',async()=>{
 const gate=new ProviderGate(2,1000),started:number[]=[],finish:Array<()=>void>=[];
 let running=0,peak=0;
 const job=(n:number)=>gate.run(async()=>{
  running++;peak=Math.max(peak,running);started.push(n);
  await new Promise<void>(resolve=>finish.push(resolve));
  running--;return n;
 });
 const all=[1,2,3,4].map(job);
 await tick();
 assert.deepEqual(started,[1,2]);
 finish.shift()!();await tick();
 assert.deepEqual(started,[1,2,3]);
 while(finish.length){finish.shift()!();await tick();}
 assert.deepEqual(await Promise.all(all),[1,2,3,4]);
 assert.equal(peak,2);
});

test('a job that fails gives its slot back',async()=>{
 const gate=new ProviderGate(1,1000);
 await assert.rejects(gate.run(async()=>{throw new Error('Stripe failed');}),/Stripe failed/);
 assert.equal(await gate.run(async()=>'next'),'next');
});

test('a waiter gives up with PAYMENTS_BUSY and leaves the queue',async()=>{
 const gate=new ProviderGate(1,20);
 let release!:()=>void;
 const first=gate.run(()=>new Promise<void>(resolve=>release=resolve));
 await assert.rejects(gate.run(async()=>'late'),{code:'PAYMENTS_BUSY'});
 release();await first;
 // The timed-out waiter did not take the slot.
 assert.equal(await gate.run(async()=>'next'),'next');
});

test('each pool gets one gate sized to a third of its connections, at least one',()=>{
 const pool=(max:number)=>({options:{max}}) as unknown as Pool;
 const ten=pool(10);
 assert.equal(providerGate(ten).limit,3);
 assert.equal(providerGate(ten),providerGate(ten));
 assert.equal(providerGate(pool(2)).limit,1);
});
