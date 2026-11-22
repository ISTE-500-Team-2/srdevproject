// Guided reader setup rows: setup gateways (app_reader_setup_gateway), the readers each one
// detects (app_reader_setup_device) and the expiring jobs between them (app_reader_setup_job).

import type { Database } from "../../db.js";

/** Setup jobs, devices and gateways for the administrator wizard and gateway polls. */
export class ReaderSetupRepository {
  constructor(private db: Database) {}

  // Administrator wizard.
  async expireJobs() {
    await this.db.query(`UPDATE app_reader_setup_job SET status='expired',payload_encrypted=NULL,updated_at=NOW()
      WHERE status NOT IN ('complete','failed','cancelled','expired') AND expires_at<=NOW()`);
  }
  async gateways(ids: string[]) {
    return (
      await this.db.query(
        "SELECT id,last_seen_at AS \"lastSeenAt\",last_seen_at>NOW()-INTERVAL '15 seconds' AS online FROM app_reader_setup_gateway WHERE id=ANY($1)",
        [ids],
      )
    ).rows;
  }
  /**
   * A device that finished setup stays listed, named after the reader it is set up as, so
   * it can be set up again after a Wi-Fi change, a reset or a move.
   */
  async devices(ids: string[]) {
    return (
      await this.db.query(
        `SELECT d.gateway_id AS "gatewayId",d.device_id AS id,d.model,d.firmware,d.transport,
      d.last_seen_at AS "lastSeenAt",d.last_seen_at>NOW()-INTERVAL '12 seconds' AS connected,
      (SELECT r.name FROM app_reader_setup_job j JOIN app_access_reader r ON r.id=j.reader_id
        WHERE j.device_id=d.device_id AND j.status='complete' ORDER BY j.created_at DESC LIMIT 1) AS "readerName"
      FROM app_reader_setup_device d WHERE d.gateway_id=ANY($1)
      ORDER BY d.gateway_id,d.device_id`,
        [ids],
      )
    ).rows;
  }
  async jobs(ids: string[]) {
    return (
      await this.db.query(
        `SELECT j.id,j.gateway_id AS "gatewayId",j.device_id AS "deviceId",j.reader_id AS "readerId",r.name,
      CASE WHEN j.expires_at<=NOW() AND j.status NOT IN ('complete','failed','cancelled','expired') THEN 'expired' ELSE j.status END AS status,
      j.error_code AS "errorCode",j.updated_at AS "updatedAt",j.expires_at AS "expiresAt"
      FROM app_reader_setup_job j JOIN app_access_reader r ON r.id=j.reader_id WHERE j.gateway_id=ANY($1)
      ORDER BY j.created_at DESC LIMIT 64`,
        [ids],
      )
    ).rows;
  }
  /** The detected device, while both it and its gateway are still reporting. */
  async lockLiveDevice(gatewayId: string, deviceId: string) {
    return (
      await this.db.query(
        `SELECT d.* FROM app_reader_setup_device d JOIN app_reader_setup_gateway g ON g.id=d.gateway_id
        WHERE d.gateway_id=$1 AND d.device_id=$2 AND d.last_seen_at>NOW()-INTERVAL '12 seconds'
        AND g.last_seen_at>NOW()-INTERVAL '15 seconds' FOR UPDATE OF d`,
        [gatewayId, deviceId],
      )
    ).rows[0];
  }
  async unfinishedJob(gatewayId: string, deviceId: string) {
    return (
      await this.db.query(
        `SELECT id FROM app_reader_setup_job WHERE gateway_id=$1 AND device_id=$2
        AND status NOT IN ('complete','failed','cancelled','expired')`,
        [gatewayId, deviceId],
      )
    ).rows[0];
  }
  /** A reader created by setup stays off until its gateway verifies it. */
  async createReader(
    readerId: string,
    name: string,
    kind: unknown,
    resourceId: number,
    secretEncrypted: string,
  ) {
    await this.db.query(
      `INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted,enabled) VALUES($1,$2,$3,$4,$5,false)`,
      [readerId, name, kind, resourceId, secretEncrypted],
    );
  }
  async createJob(
    id: string,
    gatewayId: string,
    deviceId: string,
    readerId: string,
    payloadEncrypted: string,
  ) {
    await this.db.query(
      `INSERT INTO app_reader_setup_job(id,gateway_id,device_id,reader_id,payload_encrypted) VALUES($1,$2,$3,$4,$5)`,
      [id, gatewayId, deviceId, readerId, payloadEncrypted],
    );
  }
  async lockJob(id: unknown) {
    return (
      await this.db.query(
        "SELECT * FROM app_reader_setup_job WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
  }
  async cancelJob(id: string) {
    await this.db.query(
      "UPDATE app_reader_setup_job SET status='cancelled',payload_encrypted=NULL,updated_at=NOW() WHERE id=$1",
      [id],
    );
  }
  async disableReader(readerId: string) {
    await this.db.query(
      "UPDATE app_access_reader SET enabled=false WHERE id=$1",
      [readerId],
    );
  }

  // Gateway polls.
  /** Serializes one gateway's polls for the rest of the transaction. */
  async lockGateway(gatewayId: string) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "reader-setup:" + gatewayId,
    ]);
  }
  async registerGateway(gatewayId: string) {
    await this.db.query(
      "INSERT INTO app_reader_setup_gateway(id) VALUES($1) ON CONFLICT(id) DO NOTHING",
      [gatewayId],
    );
  }
  /** The gateway's last accepted report, for replay checks; registerGateway made the row. */
  async lockLastReport(gatewayId: string) {
    return (
      await this.db.query(
        "SELECT last_report_stamp,last_report_id FROM app_reader_setup_gateway WHERE id=$1 FOR UPDATE",
        [gatewayId],
      )
    ).rows[0]!;
  }
  async recordReport(gatewayId: string, stamp: string, eventId: string) {
    await this.db.query(
      "UPDATE app_reader_setup_gateway SET last_seen_at=NOW(),last_report_stamp=$2,last_report_id=$3 WHERE id=$1",
      [gatewayId, stamp, eventId],
    );
  }
  async saveDevice(
    gatewayId: string,
    deviceId: string,
    model: string,
    firmware: string | null,
    transport: string,
  ) {
    await this.db.query(
      `INSERT INTO app_reader_setup_device(gateway_id,device_id,model,firmware,transport)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(gateway_id,device_id) DO UPDATE
        SET model=EXCLUDED.model,firmware=EXCLUDED.firmware,transport=EXCLUDED.transport,last_seen_at=NOW()`,
      [gatewayId, deviceId, model, firmware, transport],
    );
  }
  async expireGatewayJobs(gatewayId: string) {
    await this.db.query(
      `UPDATE app_reader_setup_job SET status='expired',payload_encrypted=NULL,updated_at=NOW()
        WHERE gateway_id=$1 AND status NOT IN ('complete','failed','cancelled','expired') AND expires_at<=NOW()`,
      [gatewayId],
    );
  }
  async lockGatewayJob(id: string, gatewayId: string) {
    return (
      await this.db.query(
        "SELECT * FROM app_reader_setup_job WHERE id=$1 AND gateway_id=$2 FOR UPDATE",
        [id, gatewayId],
      )
    ).rows[0];
  }
  async markRecoveryRequired(id: string) {
    await this.db.query(
      "UPDATE app_reader_setup_job SET error_code='recovery_required',updated_at=NOW() WHERE id=$1 AND error_code IS DISTINCT FROM 'recovery_required'",
      [id],
    );
  }
  async lockSetupReader(readerId: string) {
    return (
      await this.db.query(
        "SELECT last_seen_at,enabled,revision FROM app_access_reader WHERE id=$1 FOR UPDATE",
        [readerId],
      )
    ).rows[0];
  }
  async markVerifying(id: string) {
    await this.db.query(
      "UPDATE app_reader_setup_job SET status='verifying',updated_at=NOW() WHERE id=$1 AND status<>'verifying'",
      [id],
    );
  }
  async failVerification(id: string) {
    await this.db.query(
      "UPDATE app_reader_setup_job SET status='failed',error_code='verification_failed',payload_encrypted=NULL,updated_at=NOW() WHERE id=$1",
      [id],
    );
  }
  async enableReader(readerId: string) {
    await this.db.query(
      "UPDATE app_access_reader SET enabled=true,revision=revision+1 WHERE id=$1",
      [readerId],
    );
  }
  /** Turns off other readers this device was set up as before; returns their IDs. */
  async retireEarlierReaders(deviceId: string, jobId: string) {
    return (
      await this.db.query(
        `UPDATE app_access_reader r SET enabled=false,revision=r.revision+1 FROM app_reader_setup_job j
              WHERE j.reader_id=r.id AND j.device_id=$1 AND j.status='complete' AND j.id<>$2 AND r.enabled
              RETURNING r.id`,
        [deviceId, jobId],
      )
    ).rows.map((r) => r.id);
  }
  async cancelEnrollments(readerIds: string[]) {
    await this.db.query(
      "UPDATE app_card_enrollment SET cancelled_at=NOW() WHERE reader_id=ANY($1) AND completed_at IS NULL AND cancelled_at IS NULL",
      [readerIds],
    );
  }
  async applyUpdate(id: string, status: string, errorCode: string | null) {
    await this.db.query(
      `UPDATE app_reader_setup_job SET status=$2,error_code=$3,updated_at=NOW(),
          payload_encrypted=CASE WHEN $2 IN ('complete','failed') THEN NULL ELSE payload_encrypted END
          WHERE id=$1 AND (status IS DISTINCT FROM $2 OR error_code IS DISTINCT FROM $3)`,
      [id, status, errorCode],
    );
  }
  /** The gateway's unfinished jobs and those finished in the last day, unfinished first. */
  async gatewayJobs(gatewayId: string) {
    return (
      await this.db.query(
        `SELECT j.*,r.secret_encrypted FROM app_reader_setup_job j
        JOIN app_access_reader r ON r.id=j.reader_id WHERE j.gateway_id=$1
        AND (j.status NOT IN ('complete','failed','cancelled','expired') OR j.updated_at>NOW()-INTERVAL '1 day')
        ORDER BY (j.status IN ('complete','failed','cancelled','expired')),j.created_at DESC LIMIT 64`,
        [gatewayId],
      )
    ).rows;
  }
}
