import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { BillingPricing } from '../../src/billing/pricing.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_partner_guard_' + randomBytes(5).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const pricing = new BillingPricing(pool);
let created = false, member: number, admin: number, staff: number, colleague: number;
const verification = { reference: 'Approved test school partnership', validUntil: '2030-03-01' };

async function staffAccount(email: string) {
  const id = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status,primary_role)
    VALUES('Partner','Staff',$1,'unused','0000000000','active','staff') RETURNING userid`, [email])).rows[0].userid as number;
  await pool.query("INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'", [id]);
  return id;
}
const eligible = async () => (await pool.query('SELECT userid FROM app_partner_eligibility ORDER BY userid')).rows.map(r => r.userid as number);

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  member = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  admin = (await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  staff = await staffAccount('partner-staff@example.invalid');
  colleague = await staffAccount('partner-colleague@example.invalid');
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('nobody verifies their own school-partner eligibility, and only administrators verify a staff account', async () => {
  // Staff verifying a colleague is refused below, so the message must point to an administrator.
  await assert.rejects(pricing.verifyPartner(staff, staff, verification), { code: 'SELF_CHANGE_FORBIDDEN', message: /Another administrator/ });
  await assert.rejects(pricing.verifyPartner(staff, colleague, verification), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(pricing.verifyPartner(staff, admin, verification), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(pricing.verifyPartner(admin, admin, verification), { code: 'SELF_CHANGE_FORBIDDEN' });
  assert.deepEqual(await eligible(), [], 'a refused verification records nothing');

  // Staff still verify members, and administrators verify staff.
  await pricing.verifyPartner(staff, member, verification);
  await pricing.verifyPartner(admin, colleague, verification);
  assert.deepEqual(await eligible(), [member, colleague].sort((a, b) => a - b));
});
