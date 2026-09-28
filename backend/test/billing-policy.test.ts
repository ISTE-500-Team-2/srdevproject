import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cancellationBoundary} from '../src/billing/policy.js';
const s=(v:string)=>Date.parse(v)/1000;
test('30 days notice uses complete monthly periods and preserves month-end anchor',()=>{
 assert.equal(cancellationBoundary(s('2030-02-28'),s('2030-01-31'),s('2030-02-01')),s('2030-03-31'));
 assert.equal(cancellationBoundary(s('2030-03-31'),s('2030-01-31'),s('2030-03-01')),s('2030-03-31'));
 assert.equal(cancellationBoundary(s('2030-03-31'),s('2030-01-31'),s('2030-03-02')),s('2030-04-30'));
});
