import { randomBytes, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { ReaderRegistry, type DeviceConfig } from '../../src/readerRegistry.js';
import { SessionModel } from '../../src/models/SessionModel.js';
import { concurrent } from './metrics.js';

export interface LoadMember { id: number; uid: string; readerId: string; token: string; missingWaiver: boolean; missingTraining: boolean }

export async function loadFixture(users: number, poolMax: number, durationSeconds: number) {
  if (!process.env.PGHOST || process.env.DATABASE_URL || process.env.PGSERVICE || process.env.NODE_ENV === 'production')
    throw Error('Load tests require explicit PGHOST, outside production, without DATABASE_URL or PGSERVICE. They create a new disposable database.');
  const database = `arbor_load_${randomBytes(6).toString('hex')}_mvc_test`;
  const owner = new Pool({ database: 'postgres', max: 1, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ database, max: poolMax, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'arbor-load-test' });
  let created = false, server: Server | undefined;
  const close = async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve()); server!.closeAllConnections();
      });
    } finally {
      try { await pool.end(); }
      finally {
        try { if (created) await owner.query(`DROP DATABASE "${database}"`); }
        finally { await owner.end(); }
      }
    }
  };
  try {
    await owner.query(`CREATE DATABASE "${database}"`); created = true;
    await initializeDemo(pool);
    const lifetime = Math.max(3600, durationSeconds + 1800);
    const actor = (await pool.query(`SELECT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid) WHERE r.role='admin' LIMIT 1`)).rows[0].userid;
    const certId = (await pool.query(`INSERT INTO certifications(certid,name,effectivedate,training_minutes)
      SELECT COALESCE(max(certid),0)+1,'Load training',NOW() AT TIME ZONE 'UTC',30 FROM certifications RETURNING certid`)).rows[0].certid as number;
    const ids = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
      SELECT 'Load'||n,'Member','load-'||n||'@example.invalid','No password login in load fixtures','0000000000','1980-01-01','active',true
      FROM generate_series(1,$1) n RETURNING userid`, [users])).rows.map(r => r.userid as number);
    await pool.query(`INSERT INTO user_role(userid,roleid) SELECT unnest($1::int[]),roleid FROM role WHERE role='member'`, [ids]);
    await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
      SELECT unnest($1::int[]),1,(NOW()-interval '1 day') AT TIME ZONE 'UTC',(NOW()+$2*interval '1 second') AT TIME ZONE 'UTC','active'`, [ids, lifetime]);
    const machines = (await pool.query(`INSERT INTO equipment(name,category,location,status,hourlyrate,waiverrequired,certid)
      SELECT 'Load machine '||n,'Load test','Synthetic shop','available',0,true,$2 FROM generate_series(1,$1) n RETURNING equipmentid`, [users, certId])).rows.map(r => r.equipmentid as number);
    await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
      SELECT u,e,'Synthetic shop',(NOW()-interval '1 minute') AT TIME ZONE 'UTC',(NOW()+$3*interval '1 second') AT TIME ZONE 'UTC','confirmed'
      FROM unnest($1::int[],$2::int[]) p(u,e)`, [ids, machines, lifetime]);
    // One cohort lacks a facility signature; another lacks machine training.
    const missingWaiver = ids.filter((_, i) => i % 10 === 0);
    const trained = ids.filter((_, i) => i % 10 !== 1);
    await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
      SELECT (SELECT COALESCE(max(usercertid),0) FROM user_certifications)+row_number() OVER(),u,$2,'active',
      (NOW()+$3*interval '1 second') AT TIME ZONE 'UTC' FROM unnest($1::int[]) u`, [trained, certId, lifetime]);
    await pool.query(`WITH current_waivers AS (
      SELECT DISTINCT ON(name) waiverid,policy_scope FROM waiver WHERE isactive AND required
        AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
      ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
    ) INSERT INTO user_waiver(userid,waiverid,signdate,approval,expires_at)
      SELECT u,w.waiverid,NOW() AT TIME ZONE 'UTC',true,NOW()+$3*interval '1 second'
      FROM unnest($1::int[]) u CROSS JOIN current_waivers w
      WHERE NOT(u=ANY($2::int[]) AND w.policy_scope='facility')`, [ids, missingWaiver, lifetime]);
    const secret = randomBytes(32).toString('hex');
    const devices: DeviceConfig = { cardHashKey: randomBytes(32).toString('hex'), readers: [] };
    const registry = new ReaderRegistry(pool, devices);
    const encrypted = registry.encrypt(secret);
    await pool.query(`INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted)
      VALUES('load-entrance','Load entrance','building',1,$1)`, [encrypted]);
    await pool.query(`INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted)
      SELECT 'load-equipment-'||e,'Load equipment '||e,'equipment',e,$2 FROM unnest($1::int[]) e`, [machines, encrypted]);
    const members: LoadMember[] = ids.map((id, i) => ({ id, uid: (0x10000000 + i).toString(16).toUpperCase(), readerId: `load-equipment-${machines[i]}`, token: '', missingWaiver: i % 10 === 0, missingTraining: i % 10 === 1 }));
    await pool.query(`INSERT INTO app_access_card(user_id,uid_hash,uid_last4,label,assigned_by)
      SELECT u,h,l,'Synthetic load card',$4 FROM unnest($1::int[],$2::text[],$3::text[]) p(u,h,l)`,
    [ids, members.map(m => createHmac('sha256', devices.cardHashKey).update(m.uid).digest('hex')), members.map(m => m.uid.slice(-4)), actor]);
    const jwtKey = randomBytes(32);
    const accessTokenSeconds = 900;
    const sessions = new SessionModel(pool, jwtKey, accessTokenSeconds);
    let refreshedAt = 0;
    // Session creation is fixture preparation, not part of measured HTTP traffic.
    // Recreate synthetic sessions between windows on long soaks; API requests
    // still verify signatures, revocation, expiry and current permissions normally.
    const refreshSessions = async () => {
      if (Date.now() - refreshedAt < 10 * 60_000) return;
      await concurrent(users, Math.min(poolMax, 10), async i => { members[i]!.token = (await sessions.create(ids[i]!, false)).token; });
      refreshedAt = Date.now();
    };
    await refreshSessions();
    await pool.query('ANALYZE');
    const app = createApp(pool, { jwtKey, port: 0, host: '127.0.0.1', secureCookies: false, demoLogin: false, allowedOrigins: [], timeZone: 'America/New_York', devices });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Load server did not bind');
    return { pool, members, certId, secret, origin: `http://127.0.0.1:${address.port}`, close, refreshSessions };
  } catch (error) { await close(); throw error; }
}
