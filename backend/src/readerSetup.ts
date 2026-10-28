import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import { AppError, positiveId, textField } from './domain.js';
import { authState, requireCsrf } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { StaffModel } from './models/StaffModel.js';
import { assertReaderTarget, ReaderRegistry, requireDeviceConfig } from './readerRegistry.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deviceId = /^(usb|net)-[a-f0-9]{24}$/;
const stages = ['queued','backing_up','connecting','pairing','verifying','complete','failed','cancelled','expired'];
const errors = new Set(['disconnected','unsupported_firmware','backup_failed','wifi_failed','pairing_failed','verification_failed','cancelled','internal_error']);
const terminal = ['complete','failed','cancelled','expired'];

/** Dedicated gateway authentication, NOT a member cookie or an access-reader key. */
export function readerSetupPoll(pool: Pool, registry: ReaderRegistry): RequestHandler {
  return async (req, res) => {
    const config = requireDeviceConfig(registry.config);
    const id = req.get('X-Gateway-ID') ?? '', stamp = req.get('X-Gateway-Timestamp') ?? '', signature = req.get('X-Gateway-Signature') ?? '';
    const gateway = config.setupGateways?.find(g => g.id === id);
    const authError = () => new AppError(401,'GATEWAY_AUTH_REQUIRED','Gateway authentication failed.');
    if (!gateway || !/^\d{13}$/.test(stamp) || Math.abs(Date.now()-Number(stamp))>15000
        || !/^[a-f0-9]{64}$/.test(signature) || !Buffer.isBuffer(req.body)) throw authError();
    const expected = createHmac('sha256',gateway.secret).update(stamp+'\n').update(req.body).digest();
    if (!timingSafeEqual(expected,Buffer.from(signature,'hex'))) throw authError();
    let body: any;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { throw new AppError(400,'INVALID_JSON','Invalid gateway report.'); }
    if (!body || !uuid.test(body.eventId) || !Array.isArray(body.devices) || body.devices.length>32
        || !Array.isArray(body.updates) || body.updates.length>32) throw new AppError(400,'INVALID_REPORT','Invalid gateway report.');
    const seen = new Set();
    for (const d of body.devices) {
      if (!d || typeof d.id!=='string' || !deviceId.test(d.id) || seen.has(d.id)
          || !['usb','network'].includes(d.transport) || typeof d.model!=='string' || !d.model.trim() || d.model.length>80
          || (d.firmware !== undefined && (typeof d.firmware!=='string' || d.firmware.length>80)))
        throw new AppError(400,'INVALID_REPORT','Invalid detected reader.');
      seen.add(d.id);
    }
    for (const u of body.updates) {
      if (!u || !uuid.test(u.id) || !stages.includes(u.status) || u.status==='queued'
          || (u.errorCode !== undefined && !errors.has(u.errorCode)))
        throw new AppError(400,'INVALID_REPORT','Invalid setup update.');
    }
    const data = await transaction(pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",['reader-setup:'+id]);
      await db.query('INSERT INTO app_reader_setup_gateway(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen_at=NOW()',[id]);
      const receipt = await db.query('INSERT INTO app_reader_setup_receipt(gateway_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[id,body.eventId]);
      if (!receipt.rowCount) throw new AppError(409,'REPLAYED_REPORT','Send a new gateway report.');
      await db.query("DELETE FROM app_reader_setup_receipt WHERE gateway_id=$1 AND created_at<NOW()-INTERVAL '1 day'",[id]);
      for (const d of body.devices) await db.query(`INSERT INTO app_reader_setup_device(gateway_id,device_id,model,firmware,transport)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(gateway_id,device_id) DO UPDATE
        SET model=EXCLUDED.model,firmware=EXCLUDED.firmware,transport=EXCLUDED.transport,last_seen_at=NOW()`,[id,d.id,d.model,d.firmware??null,d.transport]);
      await db.query(`UPDATE app_reader_setup_job SET status='expired',payload_encrypted=NULL,updated_at=NOW()
        WHERE gateway_id=$1 AND status NOT IN ('complete','failed','cancelled','expired') AND expires_at<=NOW()`,[id]);
      for (const u of body.updates) {
        const job = (await db.query('SELECT * FROM app_reader_setup_job WHERE id=$1 AND gateway_id=$2 FOR UPDATE',[u.id,id])).rows[0];
        if (!job || terminal.includes(job.status)) continue;
        if (u.status==='complete') {
          // A Pi claim alone cannot enable access: this NEW credential must have
          // already authenticated a real heartbeat. PN532 readiness is separately
          // attested by the bound, authenticated provisioning gateway.
          const reader = (await db.query('SELECT last_seen_at,enabled,revision FROM app_access_reader WHERE id=$1 FOR UPDATE',[job.reader_id])).rows[0];
          if (u.readerReady!==true || !reader?.last_seen_at || reader.last_seen_at<job.created_at
              || Date.now()-new Date(reader.last_seen_at).getTime()>15000 || reader.enabled || reader.revision!==1)
            throw new AppError(409,'READER_NOT_VERIFIED','Reader verification is not complete.');
          await db.query('UPDATE app_access_reader SET enabled=true,revision=revision+1 WHERE id=$1',[job.reader_id]);
        }
        if (['cancelled','expired'].includes(u.status)) continue; // Admin/server-owned transitions.
        await db.query(`UPDATE app_reader_setup_job SET status=$2,error_code=$3,updated_at=NOW(),
          payload_encrypted=CASE WHEN $2 IN ('complete','failed') THEN NULL ELSE payload_encrypted END WHERE id=$1`,[u.id,u.status,u.errorCode??null]);
      }
      const jobs = (await db.query(`SELECT j.*,r.secret_encrypted FROM app_reader_setup_job j
        JOIN app_access_reader r ON r.id=j.reader_id WHERE j.gateway_id=$1
        AND (j.status NOT IN ('complete','failed','cancelled','expired') OR j.updated_at>NOW()-INTERVAL '1 day')
        ORDER BY (j.status IN ('complete','failed','cancelled','expired')),j.created_at DESC LIMIT 64`,[id])).rows;
      return {eventId:body.eventId,gatewayId:id,jobs:jobs.map(j=>({id:j.id,deviceId:j.device_id,readerId:j.reader_id,status:j.status,
        ...(!terminal.includes(j.status) ? {readerSecret:registry.decrypt(j.secret_encrypted),...JSON.parse(registry.decrypt(j.payload_encrypted))} : {})}))};
    });
    res.json({data});
  };
}

export function readerSetupRoutes(pool: Pool, timeZone: string, registry: ReaderRegistry) {
  const routes = Router(), read = requirePermission(pool,'user','read'), write = requirePermission(pool,'user_access','update');
  routes.get('/admin/access/reader-setup',read,async (_req,res)=>{
    const gateways = registry.config?.setupGateways ?? [];
    // With no installed gateway, do not pretend to scan the browser's LAN.
    if (!gateways.length) { res.json({data:{configured:false,gateways:[],devices:[],jobs:[]}}); return; }
    const ids = gateways.map(g=>g.id);
    const live = (await pool.query("SELECT id,last_seen_at AS \"lastSeenAt\",last_seen_at>NOW()-INTERVAL '15 seconds' AS online FROM app_reader_setup_gateway WHERE id=ANY($1)",[ids])).rows;
    const devices = (await pool.query(`SELECT d.gateway_id AS "gatewayId",d.device_id AS id,d.model,d.firmware,d.transport,
      d.last_seen_at AS "lastSeenAt",d.last_seen_at>NOW()-INTERVAL '12 seconds' AS connected
      FROM app_reader_setup_device d WHERE d.gateway_id=ANY($1) AND NOT EXISTS
      (SELECT 1 FROM app_reader_setup_job j WHERE j.gateway_id=d.gateway_id AND j.device_id=d.device_id AND j.status='complete')
      ORDER BY d.gateway_id,d.device_id`,[ids])).rows;
    const jobs = (await pool.query(`SELECT j.id,j.gateway_id AS "gatewayId",j.device_id AS "deviceId",j.reader_id AS "readerId",r.name,
      CASE WHEN j.expires_at<=NOW() AND j.status NOT IN ('complete','failed','cancelled','expired') THEN 'expired' ELSE j.status END AS status,
      j.error_code AS "errorCode",j.updated_at AS "updatedAt",j.expires_at AS "expiresAt"
      FROM app_reader_setup_job j JOIN app_access_reader r ON r.id=j.reader_id WHERE j.gateway_id=ANY($1)
      ORDER BY j.created_at DESC LIMIT 64`,[ids])).rows;
    res.json({data:{configured:true,gateways:gateways.map(g=>({id:g.id,name:g.name,online:false,...live.find(l=>l.id===g.id)})),devices,jobs}});
  });
  routes.post('/admin/access/reader-setup',write,requireCsrf,async (req,res)=>{
    requireDeviceConfig(registry.config); await registry.ready();
    const gatewayId = textField(req.body.gatewayId,'Gateway',64), detectedId = textField(req.body.deviceId,'Detected reader',64);
    if (!registry.config?.setupGateways?.some(g=>g.id===gatewayId) || !deviceId.test(detectedId)) throw new AppError(400,'INVALID_DEVICE','Choose a detected reader.');
    const name=textField(req.body.name,'Reader name',100),reason=textField(req.body.reason,'Reason',500),kind=req.body.kind,resourceId=positiveId(req.body.resourceId);
    const ssid=typeof req.body.ssid==='string'?req.body.ssid:'',password=typeof req.body.password==='string'?req.body.password:'';
    if (Buffer.byteLength(ssid)<1 || Buffer.byteLength(ssid)>32 || Buffer.byteLength(password)>63 || /[\r\n\0]/.test(ssid+password))
      throw new AppError(400,'INVALID_WIFI','Enter a Wi-Fi name (up to 32 bytes) and password (up to 63 bytes).');
    const data=await transaction(pool,async db=>{
      const device=(await db.query(`SELECT d.* FROM app_reader_setup_device d JOIN app_reader_setup_gateway g ON g.id=d.gateway_id
        WHERE d.gateway_id=$1 AND d.device_id=$2 AND d.last_seen_at>NOW()-INTERVAL '12 seconds'
        AND g.last_seen_at>NOW()-INTERVAL '15 seconds' FOR UPDATE OF d`,[gatewayId,detectedId])).rows[0];
      if (!device) throw new AppError(409,'DEVICE_DISCONNECTED','Reader disconnected. Reconnect it to the Pi and try again.');
      if (device.transport!=='usb') throw new AppError(409,'USB_REQUIRED','Connect this reader to the Pi by USB to securely finish setup.');
      const existing=(await db.query(`SELECT id FROM app_reader_setup_job WHERE gateway_id=$1 AND device_id=$2
        AND status NOT IN ('failed','cancelled','expired')`,[gatewayId,detectedId])).rows[0];
      if(existing) throw new AppError(409,'SETUP_IN_PROGRESS','This reader already has a setup. Check its progress instead.');
      await assertReaderTarget(db,kind,resourceId);
      const id=randomUUID(),readerId='reader-'+randomUUID().replaceAll('-','').slice(0,24),secret=randomBytes(32).toString('hex');
      await db.query(`INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted,enabled) VALUES($1,$2,$3,$4,$5,false)`,[readerId,name,kind,resourceId,registry.encrypt(secret)]);
      await db.query(`INSERT INTO app_reader_setup_job(id,gateway_id,device_id,reader_id,payload_encrypted) VALUES($1,$2,$3,$4,$5)`,[id,gatewayId,detectedId,readerId,registry.encrypt(JSON.stringify({ssid,password}))]);
      await new StaffModel(db,timeZone).audit(authState(res).user.id,null,'access.reader_setup_started','access_reader',0,reason,null,{id:readerId,name,kind,resourceId,gatewayId});
      return {id,readerId,status:'queued'};
    });
    res.status(201).json({data}); // No Wi-Fi password or signing key in browser responses/audit.
  });
  routes.post('/admin/access/reader-setup/:id/cancel',write,requireCsrf,async (req,res)=>{
    if(!uuid.test(String(req.params.id))) throw new AppError(400,'INVALID_SETUP','Choose a current setup.');
    await transaction(pool,async db=>{
      const job=(await db.query('SELECT * FROM app_reader_setup_job WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!job) throw new AppError(404,'NOT_FOUND','Setup not found.');
      if(job.status==='complete') throw new AppError(409,'SETUP_COMPLETE','This reader is already connected. Manage it from Readers.');
      if(['cancelled','expired','failed'].includes(job.status)) return;
      await db.query("UPDATE app_reader_setup_job SET status='cancelled',payload_encrypted=NULL,updated_at=NOW() WHERE id=$1",[job.id]);
      await db.query('UPDATE app_access_reader SET enabled=false WHERE id=$1',[job.reader_id]);
      await new StaffModel(db,timeZone).audit(authState(res).user.id,null,'access.reader_setup_cancelled','access_reader',0,'Cancelled reader setup',null,{id:job.reader_id});
    });
    res.json({data:{cancelled:true}});
  });
  return routes;
}
