import assert from 'node:assert/strict';
import test from 'node:test';
import {refundTransition} from '../src/billing/refundTransition.js';

// The two guard lines previously inlined in passes.applyRefund and
// MembershipBilling.applyRefund, copied verbatim as the reference.
function inlineGuards(r:{refund_id:string|null;refund_status:string|null},f:{id:string;status:string|null}):'skip'|'apply' {
  const failed=['failed','canceled'].includes(f.status??'');
  if(r.refund_status==='succeeded'&&!(r.refund_id===f.id&&failed))return 'skip';
  if(r.refund_id===f.id&&(r.refund_status===f.status||['failed','canceled'].includes(r.refund_status as string)&&f.status==='pending'))return 'skip';
  return 'apply';
}

const statuses=[null,'pending','requires_action','succeeded','failed','canceled','unexpected'];
const ids=[null,'re_same','re_other'];

test('refundTransition matches the old inline guards for every recorded/incoming combination',()=>{
  let cases=0;
  for(const refundId of ids)for(const refundStatus of statuses)for(const status of statuses){
    const refund={id:'re_same',status};
    assert.equal(refundTransition({refundId,refundStatus},refund),inlineGuards({refund_id:refundId,refund_status:refundStatus},refund),
      JSON.stringify({refundId,refundStatus,status}));
    cases++;
  }
  assert.equal(cases,ids.length*statuses.length*statuses.length);
});

test('a recorded success is only reopened by that same refund failing',()=>{
  const done={refundId:'re_1',refundStatus:'succeeded'};
  assert.equal(refundTransition(done,{id:'re_1',status:'failed'}),'apply');
  assert.equal(refundTransition(done,{id:'re_1',status:'canceled'}),'apply');
  assert.equal(refundTransition(done,{id:'re_1',status:'pending'}),'skip');
  assert.equal(refundTransition(done,{id:'re_1',status:'succeeded'}),'skip');
  assert.equal(refundTransition(done,{id:'re_2',status:'failed'}),'skip');
  assert.equal(refundTransition(done,{id:'re_2',status:'succeeded'}),'skip');
});

test('repeats are skipped and late pending never reopens a failed refund',()=>{
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'pending'},{id:'re_1',status:'pending'}),'skip');
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'failed'},{id:'re_1',status:'pending'}),'skip');
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'canceled'},{id:'re_1',status:'pending'}),'skip');
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'failed'},{id:'re_1',status:'succeeded'}),'apply');
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'pending'},{id:'re_1',status:'succeeded'}),'apply');
  assert.equal(refundTransition({refundId:'re_1',refundStatus:'failed'},{id:'re_2',status:'pending'}),'apply');
  assert.equal(refundTransition({refundId:null,refundStatus:null},{id:'re_1',status:'pending'}),'apply');
});
