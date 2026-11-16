import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { BillingPricing } from '../../src/billing/pricing.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_plan_offers_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
let created = false, member: number;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('one plan at an unsupported rate does not take away every other offer', async () => {
  const pricing = new BillingPricing(pool);
  const before = await pricing.offers(member, '2030-01-10');
  assert.ok(before.length > 0, 'the demo catalogue has purchasable plans');
  // Rows written before plan prices were range-checked: under the card minimum and over the maximum.
  const legacy = (await pool.query(`INSERT INTO membership_tiers(tiername,kind,tierprice,allottedmonths,benefits,active)
    VALUES('Legacy cent month','membership',0.25,1,'',true),('Legacy gold pass','day_pass',150000,NULL,'',true) RETURNING tierid`))
    .rows.map(r => r.tierid as number);

  const offers = await pricing.offers(member, '2030-01-10');
  assert.deepEqual(offers.map(o => o.id).sort(), before.map(o => o.id).sort(), 'the supported plans are still offered');
  for (const id of legacy) assert.ok(!offers.some(o => o.id === id), 'an unsupported plan has no offer');
  for (const offer of offers) assert.ok(offer.amountCents === 0 || offer.amountCents >= 50 && offer.amountCents <= 10000000);
  // Other errors are not swallowed.
  await assert.rejects(pricing.offers(member, '2030-02-30'), { code: 'INVALID_INPUT' });
});
