import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { migrate } from '../../src/scripts/migrate.js';
import type { AppConfig } from '../../src/config.js';

// A fresh, disposable database is created for this run. Never reset an existing DB.
const database = 'arbor_' + randomBytes(6).toString('hex') + '_mvc_test';
const adminPool = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000, max: 10 });
const config: AppConfig = {
  jwtKey: randomBytes(32),
  port: 8080,
  host: '127.0.0.1',
  secureCookies: false,
  demoLogin: true,
  allowedOrigins: ['http://localhost:8080'],
  timeZone: 'America/New_York',
};
let created = false;
let app: ReturnType<typeof createApp>;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error(
      'Use explicit PGHOST/PGPORT/PGUSER/PGDATABASE for an isolated PostgreSQL test server.',
    );
  await adminPool.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  app = createApp(pool, config);
});
after(async () => {
  await pool.end();
  if (created) await adminPool.query(`DROP DATABASE "${database}"`);
  await adminPool.end();
});
function client() {
  const agent = request.agent(app);
  let csrf = '';
  let id = 0;
  let cookie = '';
  return {
    agent,
    get id() {
      return id;
    },
    get cookie() {
      return cookie;
    },
    async demo(role = 'member') {
      const res = await agent.post('/api/auth/demo').send({ role });
      assert.equal(res.status, 200);
      csrf = res.body.data.csrfToken;
      id = res.body.data.user.id;
      cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
      return res;
    },
    async register() {
      const email = randomBytes(8).toString('hex') + '@example.invalid',
        password = randomBytes(24).toString('hex');
      const res = await agent
        .post('/api/auth/register')
        .send({
          email,
          password,
          firstName: 'Test',
          lastName: 'Member',
          phone: '0000000000',
          role: 'admin',
        });
      assert.equal(res.status, 201);
      csrf = res.body.data.csrfToken;
      id = res.body.data.user.id;
      cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
      return { email, password, res };
    },
    async login(email: string, password: string) {
      const res = await agent.post('/api/auth/login').send({ email, password });
      assert.equal(res.status, 200);
      csrf = res.body.data.csrfToken;
      id = res.body.data.user.id;
      cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
      return res;
    },
    post(path: string, body: unknown = {}) {
      return agent
        .post('/api' + path)
        .set('X-CSRF-Token', csrf)
        .send(body);
    },
    patch(path: string, body: unknown) {
      return agent
        .patch('/api' + path)
        .set('X-CSRF-Token', csrf)
        .send(body);
    },
  };
}
async function equipment(name = '3D Printer') {
  return (
    await pool.query('SELECT equipmentid AS id FROM equipment WHERE name=$1', [
      name,
    ])
  ).rows[0].id as number;
}
function interval(equipmentId: number, days: number, hours = 1) {
  const start = new Date(Date.now() + days * 86_400_000);
  return {
    equipmentId,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  };
}
async function enableMember(id: number) {
  await pool.query(
    `INSERT INTO user_membership(userid,tierid,startdate,end_date,status) VALUES($1,1,(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 days') AT TIME ZONE 'UTC','active')`,
    [id],
  );
}

test('registration, DB session recovery, profile persistence and logout', async () => {
  const user = client();
  const { email, password, res } = await user.register();
  assert.equal(res.body.data.user.role, 'member');
  assert.equal('password' in res.body.data.user, false);
  const cookie = res.headers['set-cookie']?.[0] ?? '';
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Lax'));
  const stored = await pool.query(
    'SELECT password FROM "user" WHERE userid=$1',
    [user.id],
  );
  assert.ok(stored.rows[0].password !== password);
  const update = await user.patch('/me/profile', {
    firstName: 'Updated',
    lastName: 'Member',
    phone: '1111111111',
    role: 'admin',
  });
  assert.equal(update.status, 200);
  const session = await user.agent.get('/api/auth/session');
  assert.equal(session.body.data.user.firstName, 'Updated');
  assert.equal(session.body.data.user.role, 'member');
  assert.equal((await user.post('/auth/logout')).status, 204);
  assert.equal((await user.agent.get('/api/auth/session')).status, 401);
  const signedIn = await user.login(email, password);
  assert.equal(signedIn.body.data.user.firstName, 'Updated');
  const duplicate = await request(app)
    .post('/api/auth/register')
    .send({
      email: email.toUpperCase(),
      password,
      firstName: 'Duplicate',
      lastName: 'Member',
      phone: '0000000000',
    });
  assert.equal(duplicate.status, 409);
});

test('unauthenticated, missing CSRF, cross-origin and malformed writes are rejected', async () => {
  assert.equal((await request(app).get('/api/equipment')).status, 401);
  const user = client();
  await user.demo();
  assert.equal(
    (
      await user.agent
        .post('/api/reservations')
        .send(interval(await equipment(), 1))
    ).status,
    403,
  );
  const foreign = await user
    .post('/reservations', interval(await equipment(), 1))
    .set('Origin', 'https://untrusted.example');
  assert.equal(foreign.status, 403);
  assert.equal((await user.post('/reservations', [])).status, 400);
  assert.equal(
    (
      await user.post('/reservations', {
        equipmentId: 1,
        startTime: 'not a date',
        endTime: 'no',
      })
    ).status,
    400,
  );
  const disabled = createApp(pool, { ...config, demoLogin: false });
  assert.equal(
    (await request(disabled).post('/api/auth/demo').send({ role: 'admin' }))
      .status,
    401,
  );
});

test('reservation saves to PostgreSQL, survives a new app instance, and only its owner can cancel', async () => {
  const owner = client();
  await owner.demo();
  const input = interval(await equipment(), 2);
  const response = await owner.post('/reservations', input);
  assert.equal(response.status, 201);
  const id = response.body.data.id;
  const row = await pool.query(
    'SELECT userid,status FROM reservation WHERE reservationid=$1',
    [id],
  );
  assert.equal(row.rows[0].userid, owner.id);
  assert.equal(row.rows[0].status, 'confirmed');
  const restarted = createApp(pool, config);
  const restored = request.agent(restarted);
  const cookie = owner.cookie;
  // Recover the same browser session against a fresh controller/router instance.
  const recovered = await restored
    .get('/api/reservations')
    .set('Cookie', cookie);
  assert.equal(recovered.status, 200);
  assert.ok(recovered.body.data.some((item: { id: number }) => item.id === id));
  const other = client();
  await other.demo('admin');
  assert.equal(
    (await other.post('/reservations/' + id + '/cancel')).status,
    404,
  );
  assert.equal(
    (await owner.post('/reservations/' + id + '/cancel')).status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT status FROM reservation WHERE reservationid=$1',
        [id],
      )
    ).rows[0].status,
    'cancelled',
  );
});

test('concurrent overlapping requests produce one reservation; adjacent times are allowed', async () => {
  const one = client(),
    two = client();
  await one.demo();
  await two.demo('admin');
  const input = interval(await equipment(), 3);
  const responses = await Promise.all([
    one.post('/reservations', input),
    two.post('/reservations', input),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const next = {
    ...input,
    startTime: input.endTime,
    endTime: new Date(
      new Date(input.endTime).getTime() + 3_600_000,
    ).toISOString(),
  };
  assert.equal((await one.post('/reservations', next)).status, 201);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS count FROM reservation WHERE equipmentid=$1 AND starttime=$2::timestamptz AT TIME ZONE 'UTC'`,
    [input.equipmentId, input.startTime],
  );
  assert.equal(count.rows[0].count, 1);
  await assert.rejects(
    pool.query(
      `INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status) VALUES($1,$2,'Test',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed')`,
      [one.id, input.equipmentId, input.startTime, input.endTime],
    ),
    (error: any) => error.code === '23P01',
  );
});

test('membership, certification and waiver eligibility are enforced; check-in is recorded', async () => {
  const user = client();
  await user.register();
  const cnc = await equipment('CNC Machine');
  const input = interval(cnc, 4);
  let res = await user.post('/reservations', input);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'MEMBERSHIP_REQUIRED');
  await enableMember(user.id);
  const certId = 7001;
  await pool.query(
    `INSERT INTO certifications(certid,name,description,effectivedate) VALUES($1,'CNC safety','Test fixture',(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC')`,
    [certId],
  );
  await pool.query('UPDATE equipment SET certid=$2 WHERE equipmentid=$1', [
    cnc,
    certId,
  ]);
  res = await user.post('/reservations', input);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CERTIFICATION_REQUIRED');
  await pool.query(
    `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate) VALUES(7001,$1,$2,'active',(NOW()+INTERVAL '15 days') AT TIME ZONE 'UTC')`,
    [user.id, certId],
  );
  res = await user.post('/reservations', input);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'WAIVER_REQUIRED');
  const policies = (await user.agent.get('/api/me/waivers')).body.data;
  assert.ok(policies.length > 0);
  assert.equal(
    (
      await user.post('/me/waivers/' + policies[0].id + '/sign', {
        accepted: false,
      })
    ).status,
    400,
  );
  for (const policy of policies)
    assert.equal(
      (
        await user.post('/me/waivers/' + policy.id + '/sign', {
          accepted: true,
        })
      ).status,
      200,
    );
  assert.equal((await user.post('/reservations', input)).status, 201);
  const checkin = await user.post('/me/check-ins', {
    location: 'Integration test entrance',
  });
  assert.equal(checkin.status, 201);
  assert.equal(
    (
      await pool.query('SELECT userid FROM check_in WHERE checkinid=$1', [
        checkin.body.data.id,
      ])
    ).rows[0].userid,
    user.id,
  );
  const overview = await user.agent.get('/api/me/overview');
  assert.equal(overview.body.data.activeReservations, 1);
  assert.equal(overview.body.data.pendingWaivers, 0);
  await pool.query(
    "UPDATE user_membership SET status='expired' WHERE userid=$1",
    [user.id],
  );
  assert.equal(
    (
      await user.post('/me/check-ins', {
        location: 'Integration test entrance',
      })
    ).status,
    403,
  );
  await pool.query('UPDATE "user" SET status=\'inactive\' WHERE userid=$1', [
    user.id,
  ]);
  assert.equal((await user.agent.get('/api/equipment')).status, 403);
});

test('a day pass grants access only on its valid local calendar day', async () => {
  const user = client();
  await user.register();
  const printer = await equipment();
  await pool.query(
    `INSERT INTO day_pass(userid,validdate,purchasedate,status) VALUES($1,(NOW() AT TIME ZONE 'America/New_York')::date,NOW() AT TIME ZONE 'UTC','active')`,
    [user.id],
  );
  const overview = await user.agent.get('/api/me/overview');
  assert.equal(overview.body.data.entitlement.dayPass, true);
  assert.equal(
    (await user.post('/reservations', interval(printer, 5))).status,
    403,
  );
});

test('rerunning setup preserves users, reservations and applied migration history', async () => {
  const migrationsBefore = (await pool.query('SELECT name, checksum FROM app_migration ORDER BY name')).rows;
  const before = (
    await pool.query('SELECT COUNT(*)::int AS count FROM reservation')
  ).rows[0].count;
  await initializeDemo(pool);
  await migrate(pool);
  assert.equal(
    (await pool.query('SELECT COUNT(*)::int AS count FROM reservation')).rows[0]
      .count,
    before,
  );
  assert.deepEqual((await pool.query('SELECT name, checksum FROM app_migration ORDER BY name')).rows, migrationsBefore);
  const newUser = client();
  await newUser.register();
  assert.ok(newUser.id > 2);
});

test('additive RBAC migration upgrades existing MVC data without resetting users or reservations', async () => {
  const before = (await pool.query('SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM reservation) AS reservations')).rows[0];
  // This suite owns this disposable DB. Recreate the pre-PR3 schema state.
  await pool.query('DROP TABLE role_permission; DROP TABLE permission');
  await pool.query("DELETE FROM app_migration WHERE name='003_rbac_permissions.sql'");
  await migrate(pool);
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM reservation) AS reservations')).rows[0], before);
  const grants = await pool.query("SELECT rp.* FROM role_permission rp JOIN role r ON r.roleid=rp.roleid WHERE r.role='staff' AND rp.resourcename='payment' AND rp.permissionid=3");
  assert.equal(grants.rows.length, 1);
  await pool.query("UPDATE role_permission SET isallowed=false WHERE resourcename='payment'");
  await migrate(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM role_permission WHERE resourcename='payment' AND isallowed")).rows[0].n,0);
});
