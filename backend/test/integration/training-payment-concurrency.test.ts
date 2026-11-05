import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { StaffModel } from '../../src/models/StaffModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = `arbor_training_race_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
let created = false, server: Server, member: any, admin: any, nextDay = 2;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
let gate: { paymentId: number; winner: 'void' | 'collect'; ready: ReturnType<typeof deferred<number>>;
  resume: ReturnType<typeof deferred<void>> } | undefined;

// Pause after the first payment row lock to force the two real HTTP operations
// to overlap; the production audit triggers and user locks remain enabled.
const gatedPool = new Proxy(pool, {
  get(target, property) {
    if (property === 'connect') return async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(connection, key) {
          if (key === 'query') return async (sql: string, values?: any[]) => {
            const active = gate;
            const matches = active?.winner === 'void'
              ? sql.includes("UPDATE payment SET paymentstatus='void'")
              : sql.includes('UPDATE payment SET paymentstatus=$2::text') && values?.[0] === active?.paymentId;
            if (active && matches) {
              gate = undefined;
              await client.query('SELECT paymentid FROM payment WHERE paymentid=$1 FOR UPDATE', [active.paymentId]);
              active.ready.resolve((await client.query('SELECT pg_backend_pid() AS id')).rows[0].id);
              await active.resume.promise;
            }
            return client.query(sql, values);
          };
          const value = Reflect.get(connection, key);
          return typeof value === 'function' ? value.bind(connection) : value;
        },
      });
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const post = (path: string, body: object = {}, actor = member) => request(server).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken).send(body);

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  server = createApp(gatedPool, { jwtKey: randomBytes(32), host: '127.0.0.1', port: 8080,
    secureCookies: false, demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  admin = (await request(server).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(server).post('/api/auth/demo').send({ role: 'member' })).body.data;
});
after(async () => {
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

async function fixture() {
  const room = (await pool.query('SELECT roomid FROM room LIMIT 1')).rows[0].roomid;
  const cert = (await pool.query('SELECT certid FROM certifications LIMIT 1')).rows[0].certid;
  const reservation = (await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'Concurrency fixture',(now()+$3*interval '1 day') AT TIME ZONE 'UTC',
    (now()+$3*interval '1 day'+interval '1 hour') AT TIME ZONE 'UTC','confirmed') RETURNING reservationid`,
  [admin.user.id, room, nextDay++])).rows[0].reservationid;
  const c = (await pool.query(`INSERT INTO app_training_class(title,certification_id,instructor_id,reservation_id,capacity,created_by)
    VALUES('Training payment concurrency',$1,$2,$3,15,$2) RETURNING id,revision`, [cert, admin.user.id, reservation])).rows[0];
  const staff = new StaffModel(pool);
  const paymentId = await staff.createPayment(member.user.id, null, '20.00', 'pending', 'unspecified', '', 'Synthetic training fee', admin.user.id);
  const paidId = await staff.createPayment(admin.user.id, null, '20.00', 'paid', 'cash', 'PRIOR', 'Previously paid training', admin.user.id);
  for (const [userId, id] of [[member.user.id, paymentId], [admin.user.id, paidId]])
    await pool.query('INSERT INTO app_training_enrollment(class_id,user_id,training_fee_cents,payment_id) VALUES($1,$2,2000,$3)', [c.id, userId, id]);
  return { ...c, paymentId, paidId };
}
async function waitForBlockedOperation(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The second operation did not reach the payment lock.');
}
async function readyWithin(promise: Promise<number>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('First operation did not reach the payment lock.')), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const operation of ['withdraw', 'cancel'] as const) {
  for (const winner of ['void', 'collect'] as const) {
    test(`${operation} and collection serialize safely when ${winner} locks the payment first`, { timeout: 15000 }, async () => {
      const c = await fixture();
      const active = { paymentId: c.paymentId, winner, ready: deferred<number>(), resume: deferred<void>() };
      gate = active;
      let cancelling: Promise<any> | undefined, collecting: Promise<any> | undefined;
      const cancel = () => post(`/classes/${c.id}/${operation}`, operation === 'cancel'
        ? { expectedRevision: c.revision, reason: 'Synthetic class cancellation' } : {}, operation === 'cancel' ? admin : member).then(r => r);
      const collect = () => post(`/admin/payments/${c.paymentId}/status`, { status: 'paid', method: 'cash',
        reference: 'RACE', revision: 1, reason: 'Synthetic cash received' }, admin).then(r => r);
      try {
        if (winner === 'void') cancelling = cancel(); else collecting = collect();
        const pid = await readyWithin(active.ready.promise);
        if (winner === 'void') collecting = collect(); else cancelling = cancel();
        await waitForBlockedOperation(pid);
        active.resume.resolve();
        const [cancelled, collected] = await Promise.all([cancelling!, collecting!]);
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(collected.status, winner === 'void' ? 409 : 200, JSON.stringify(collected.body));
        if (winner === 'void') assert.equal(collected.body.error.code, 'STALE_RECORD');
        const payments = (await pool.query('SELECT paymentid,paymentstatus FROM payment WHERE paymentid=ANY($1::int[])', [[c.paymentId, c.paidId]])).rows;
        assert.equal(payments.find(p => p.paymentid === c.paymentId).paymentstatus, winner === 'void' ? 'void' : 'paid');
        assert.equal(payments.find(p => p.paymentid === c.paidId).paymentstatus, 'paid');
        if (operation === 'withdraw')
          assert.equal((await pool.query('SELECT status FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2', [c.id, member.user.id])).rows[0].status, 'cancelled');
        else assert.equal((await pool.query('SELECT status FROM app_training_class WHERE id=$1', [c.id])).rows[0].status, 'cancelled');
      } finally {
        active.resume.resolve(); gate = undefined;
        await Promise.allSettled([cancelling, collecting]);
      }
    });
  }
}
