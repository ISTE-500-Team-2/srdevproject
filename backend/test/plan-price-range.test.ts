import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planInput } from '../src/staffDomain.js';

const plan = (price: unknown) => planInput({ name: 'Monthly', kind: 'membership', price, months: 1, benefits: '', active: true });

test('staff cannot save a plan price that card checkout rejects', () => {
  for (const price of ['0.01', '0.49', '100000.01', '99999999.99'])
    assert.throws(() => plan(price), { code: 'INVALID_INPUT', message: /\$0\.00 \(free\) or between \$0\.50 and \$100,000\.00/ }, price);
});

test('free and supported plan prices are still accepted and normalized', () => {
  assert.equal(plan('0').price, '0.00');
  assert.equal(plan('0.5').price, '0.50');
  assert.equal(plan('49.99').price, '49.99');
  assert.equal(plan('100000').price, '100000.00');
  assert.throws(() => plan('1.234'), { code: 'INVALID_INPUT', message: /two decimal places/ });
});
