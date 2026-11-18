import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { Pool } from 'pg';
import type Stripe from 'stripe';
import { EquipmentBilling } from '../../src/billing/equipment.js';
import { ReservationModel } from '../../src/models/ReservationModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { stripeMock, type StripeFixture } from '../helpers/stripeFixtures.js';

type Session = StripeFixture<Stripe.Checkout.Session>;
const database = 'arbor_reconcile_backoff_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const provider = new StudioStripe({ key: 'sk_test_fixture', webhookSecret: 'whsec_fixture', origin: 'http://localhost:8080' });
const billing = new EquipmentBilling(pool, provider);
const stripe = stripeMock(provider);
let created = false, member: number, equipment: number;

// Checkouts whose Stripe lookup keeps failing never leave 'pending' on their own.
const sessions = new Map<string, Session>(), stuck = new Set<string>(), lookups = new Map<string, number>();
stripe.checkoutSessionCreate(async params => {
  const id = 'cs_backoff_' + params!.client_reference_id;
  sessions.set(id, { id, status: 'open', mode: 'payment', livemode: false, payment_status: 'unpaid', client_reference_id: params!.client_reference_id,
    metadata: params!.metadata as Record<string, string>, currency: 'usd', url: 'https://checkout.stripe.com/' + id,
    amount_total: Number(params!.line_items![0]!.quantity) * Number(params!.line_items![0]!.price_data!.unit_amount) });
  return sessions.get(id)!;
});
stripe.checkoutSessionRetrieve(async id => {
  lookups.set(id, (lookups.get(id) ?? 0) + 1);
  if (stuck.has(id)) throw new Error('Stuck checkout fixture');
  return sessions.get(id)!;
});

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  await pool.query("UPDATE user_membership SET startdate=now()-interval '1 day',end_date='2035-01-01',status='active' WHERE userid=$1", [member]);
  equipment = (await pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
    VALUES('Backoff test machine','available',7,false,'Makerspace') RETURNING equipmentid`)).rows[0].equipmentid;
});
after(async () => {
  mock.restoreAll();
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('checkouts that keep failing back off, so an abandoned hold behind them is still released', async () => {
  const error = mock.method(console, 'error', () => {});
  const service = new ReservationService(pool, 'America/New_York', provider);
  const holds: { id: number; checkout: string }[] = [];
  for (let i = 0; i < 21; i++) {
    const start = Date.UTC(2031, 0, 2 + i, 15);
    const { id } = await service.create(member, { equipmentId: equipment, startTime: new Date(start).toISOString(),
      endTime: new Date(start + 3600000).toISOString(), requestKey: randomUUID(), amountCents: 700 }) as unknown as { id: number };
    holds.push({ id, checkout: (await pool.query('SELECT checkout_id FROM app_equipment_checkout WHERE reservation_id=$1', [id])).rows[0].checkout_id });
  }
  // Twenty older holds are stuck; the newest expired without payment, but its webhook was missed.
  const blocked = holds.slice(0, 20), abandoned = holds[20]!;
  for (const [i, hold] of holds.entries())
    await pool.query(`UPDATE app_equipment_checkout SET hold_until=now()-make_interval(mins=>$2) WHERE reservation_id=$1`, [hold.id, 60 - i]);
  for (const hold of blocked) stuck.add(hold.checkout);
  sessions.get(abandoned.checkout)!.status = 'expired';
  const backoff = async () => (await pool.query(`SELECT reconcile_failures AS failures,
    round(extract(epoch FROM reconcile_after-now())/60)::int AS minutes FROM app_equipment_checkout WHERE reservation_id=ANY($1) ORDER BY reservation_id`,
    [blocked.map(hold => hold.id)])).rows;
  const looked = (hold: { checkout: string }) => lookups.get(hold.checkout) ?? 0;

  try {
    lookups.clear();
    // The batch is full of stuck holds, oldest first; each failure is recorded and backed off.
    await billing.reconcile();
    assert.equal(looked(abandoned), 0);
    assert.deepEqual(await backoff(), blocked.map(() => ({ failures: 1, minutes: 1 })));
    assert.equal((await new ReservationModel(pool).find(abandoned.id))!.status, 'pending');

    // While they wait out their backoff, the abandoned hold gets the slot and is released.
    await billing.reconcile();
    assert.equal(looked(abandoned), 1);
    assert.equal((await new ReservationModel(pool).find(abandoned.id))!.status, 'cancelled');
    assert.ok(blocked.every(hold => looked(hold) === 1), 'stuck holds are not rechecked during their backoff');

    // Each further failure waits twice as long.
    await pool.query('UPDATE app_equipment_checkout SET reconcile_after=now()-interval \'1 second\' WHERE reservation_id=ANY($1)', [blocked.map(hold => hold.id)]);
    await billing.reconcile();
    assert.deepEqual(await backoff(), blocked.map(() => ({ failures: 2, minutes: 2 })));

    // The member's own view still checks their own holds, so a fixed problem clears without waiting.
    await billing.reconcile(member);
    assert.ok(blocked.every(hold => looked(hold) === 3));
  } finally {
    error.mock.restore();
  }
});
