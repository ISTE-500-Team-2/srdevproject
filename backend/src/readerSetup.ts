// Coordinates expiring setup jobs between the administrator wizard and authenticated gateways;
// polling advances the persisted job state.

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requireStaffPermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import { ReaderSetupRepository } from "./models/access/readerSetup.js";
import {
  assertReaderTarget,
  ReaderRegistry,
  requireDeviceConfig,
} from "./readerRegistry.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deviceId = /^(usb|net)-[a-f0-9]{24}$/;
const stages = [
  "queued",
  "backing_up",
  "connecting",
  "pairing",
  "verifying",
  "complete",
  "failed",
  "cancelled",
  "expired",
];
const errors = new Set([
  "disconnected",
  "unsupported_firmware",
  "backup_failed",
  "wifi_failed",
  "wifi_already_connected",
  "pairing_failed",
  "verification_failed",
  "recovery_required",
  "cancelled",
  "internal_error",
]);
const terminal = ["complete", "failed", "cancelled", "expired"];

/** Dedicated gateway authentication, NOT a member cookie or an access-reader key. */
/**
 * Authenticate gateway reports and advance setup jobs under locks; completed verification must
 * match the current reader configuration.
 */
export function readerSetupPoll(
  pool: Pool,
  registry: ReaderRegistry,
): RequestHandler {
  return async (req, res) => {
    const config = requireDeviceConfig(registry.config);
    const id = req.get("X-Gateway-ID") ?? "",
      stamp = req.get("X-Gateway-Timestamp") ?? "",
      signature = req.get("X-Gateway-Signature") ?? "";
    const gateway = config.setupGateways?.find((g) => g.id === id);
    const authError = () =>
      new AppError(
        401,
        "GATEWAY_AUTH_REQUIRED",
        "Gateway authentication failed.",
      );
    if (
      !gateway ||
      !/^\d{13}$/.test(stamp) ||
      Math.abs(Date.now() - Number(stamp)) > 15000 ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      !Buffer.isBuffer(req.body)
    )
      throw authError();
    const expected = createHmac("sha256", gateway.secret)
      .update(stamp + "\n")
      .update(req.body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw authError();
    let body: any;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new AppError(400, "INVALID_JSON", "Invalid gateway report.");
    }
    if (
      !body ||
      !uuid.test(body.eventId) ||
      !Array.isArray(body.devices) ||
      body.devices.length > 32 ||
      !Array.isArray(body.updates) ||
      body.updates.length > 32
    )
      throw new AppError(400, "INVALID_REPORT", "Invalid gateway report.");
    const seen = new Set();
    for (const d of body.devices) {
      if (
        !d ||
        typeof d.id !== "string" ||
        !deviceId.test(d.id) ||
        seen.has(d.id) ||
        !["usb", "network"].includes(d.transport) ||
        typeof d.model !== "string" ||
        !d.model.trim() ||
        d.model.length > 80 ||
        (d.firmware !== undefined &&
          (typeof d.firmware !== "string" || d.firmware.length > 80))
      )
        throw new AppError(400, "INVALID_REPORT", "Invalid detected reader.");
      seen.add(d.id);
    }
    for (const u of body.updates) {
      if (
        !u ||
        !uuid.test(u.id) ||
        !stages.includes(u.status) ||
        u.status === "queued" ||
        (u.errorCode !== undefined && !errors.has(u.errorCode))
      )
        throw new AppError(400, "INVALID_REPORT", "Invalid setup update.");
    }
    const data = await transaction(pool, async (db) => {
      const setup = new ReaderSetupRepository(db);
      await setup.lockGateway(id);
      await setup.registerGateway(id);
      const previous = await setup.lockLastReport(id);
      if (
        Number(stamp) <= Number(previous.last_report_stamp) ||
        previous.last_report_id === body.eventId
      )
        throw new AppError(
          409,
          "REPLAYED_REPORT",
          "Send a new gateway report.",
        );
      await setup.recordReport(id, stamp, body.eventId);
      for (const d of body.devices)
        await setup.saveDevice(id, d.id, d.model, d.firmware ?? null, d.transport);
      await setup.expireGatewayJobs(id);
      for (const u of body.updates) {
        const job = await setup.lockGatewayJob(u.id, id);
        if (!job) continue;
        if (terminal.includes(job.status)) {
          if (
            ["cancelled", "expired", "failed"].includes(job.status) &&
            u.errorCode === "recovery_required"
          )
            await setup.markRecoveryRequired(job.id);
          continue;
        }
        if (u.status === "complete") {
          // A Pi claim alone cannot enable access: this NEW credential must have
          // already authenticated a real heartbeat. PN532 readiness is separately
          // attested by the bound, authenticated provisioning gateway.
          const reader = await setup.lockSetupReader(job.reader_id);
          if (
            u.readerReady !== true ||
            !reader?.last_seen_at ||
            reader.last_seen_at < job.created_at ||
            Date.now() - new Date(reader.last_seen_at).getTime() > 15000
          ) {
            // Not verified yet: keep checking and let the Pi report again. Refusing the whole
            // poll would also roll back this Pi's presence and every other reader's progress.
            await setup.markVerifying(job.id);
            continue;
          }
          if (reader.enabled || reader.revision !== 1) {
            await setup.failVerification(job.id);
            continue; // A staff edit wins; do not block this Pi's other jobs.
          }
          await setup.enableReader(job.reader_id);
          // Setting a device up again replaces its pairing, so the reader it was set up as
          // before no longer has a device. Turn that one off now, not when setup starts, so a
          // failed attempt leaves the working reader as it was.
          const retired = await setup.retireEarlierReaders(job.device_id, job.id);
          if (retired.length) await setup.cancelEnrollments(retired);
        }
        if (["cancelled", "expired"].includes(u.status)) continue; // Admin/server-owned transitions.
        await setup.applyUpdate(u.id, u.status, u.errorCode ?? null);
      }
      const jobs = await setup.gatewayJobs(id);
      return {
        eventId: body.eventId,
        gatewayId: id,
        jobs: jobs.map((j) => ({
          id: j.id,
          deviceId: j.device_id,
          readerId: j.reader_id,
          status: j.status,
          errorCode: j.error_code,
          ...(!terminal.includes(j.status)
            ? {
                readerSecret: registry.decrypt(j.secret_encrypted),
                ...JSON.parse(registry.decrypt(j.payload_encrypted)),
              }
            : {}),
        })),
      };
    });
    res.json({ data });
  };
}

export function readerSetupRoutes(
  pool: Pool,
  timeZone: string,
  registry: ReaderRegistry,
) {
  const routes = Router(),
    read = requireStaffPermission(pool, "user", "read"),
    // Guided setup ends with the gateway turning the new reader on, so starting or cancelling
    // it is hardware configuration (CON-001): administrators only, like adding a reader.
    configure = requireStaffPermission(pool, "reader", "update");
  routes.get("/admin/access/reader-setup", read, async (_req, res) => {
    const gateways = registry.config?.setupGateways ?? [];
    // With no installed gateway, do not pretend to scan the browser's LAN.
    if (!gateways.length) {
      res.json({
        data: { configured: false, gateways: [], devices: [], jobs: [] },
      });
      return;
    }
    const setup = new ReaderSetupRepository(pool);
    await setup.expireJobs();
    const ids = gateways.map((g) => g.id);
    const live = await setup.gateways(ids);
    // A device that finished setup stays listed, named after the reader it is set up as, so
    // it can be set up again after a Wi-Fi change, a reset or a move.
    const devices = await setup.devices(ids);
    const jobs = await setup.jobs(ids);
    res.json({
      data: {
        configured: true,
        gateways: gateways.map((g) => ({
          id: g.id,
          name: g.name,
          online: false,
          ...live.find((l) => l.id === g.id),
        })),
        devices,
        jobs,
      },
    });
  });
  routes.post(
    "/admin/access/reader-setup",
    configure,
    requireCsrf,
    async (req, res) => {
      requireDeviceConfig(registry.config);
      await registry.ready();
      const gatewayId = textField(req.body.gatewayId, "Gateway", 64),
        detectedId = textField(req.body.deviceId, "Detected reader", 64);
      if (
        !registry.config?.setupGateways?.some((g) => g.id === gatewayId) ||
        !deviceId.test(detectedId)
      )
        throw new AppError(400, "INVALID_DEVICE", "Choose a detected reader.");
      const name = textField(req.body.name, "Reader name", 100),
        reason = textField(req.body.reason, "Reason", 500),
        kind = req.body.kind,
        resourceId = positiveId(req.body.resourceId);
      const reuseWifi = req.body.reuseWifi === true,
        ssid = reuseWifi
          ? ""
          : typeof req.body.ssid === "string"
            ? req.body.ssid
            : "",
        password = reuseWifi
          ? ""
          : typeof req.body.password === "string"
            ? req.body.password
            : "";
      if (
        (!reuseWifi && Buffer.byteLength(ssid) < 1) ||
        Buffer.byteLength(ssid) > 32 ||
        Buffer.byteLength(password) > 63 ||
        /[\r\n\0]/.test(ssid + password)
      )
        throw new AppError(
          400,
          "INVALID_WIFI",
          "Enter a Wi-Fi name (up to 32 bytes) and password (up to 63 bytes).",
        );
      const data = await transaction(pool, async (db) => {
        const setup = new ReaderSetupRepository(db);
        const device = await setup.lockLiveDevice(gatewayId, detectedId);
        if (!device)
          throw new AppError(
            409,
            "DEVICE_DISCONNECTED",
            "Reader disconnected. Reconnect it to the Pi and try again.",
          );
        if (device.transport !== "usb")
          throw new AppError(
            409,
            "USB_REQUIRED",
            "Connect this reader to the Pi by USB to securely finish setup.",
          );
        // A finished setup does not block another: completing the new one retires that reader.
        const existing = await setup.unfinishedJob(gatewayId, detectedId);
        if (existing)
          throw new AppError(
            409,
            "SETUP_IN_PROGRESS",
            "This reader already has a setup. Check its progress instead.",
          );
        await assertReaderTarget(db, kind, resourceId);
        const id = randomUUID(),
          readerId = "reader-" + randomUUID().replaceAll("-", "").slice(0, 24),
          secret = randomBytes(32).toString("hex");
        await setup.createReader(
          readerId,
          name,
          kind,
          resourceId,
          registry.encrypt(secret),
        );
        await setup.createJob(
          id,
          gatewayId,
          detectedId,
          readerId,
          registry.encrypt(JSON.stringify({ ssid, password, reuseWifi })),
        );
        await new StaffModel(db, timeZone).audit(
          authState(res).user.id,
          null,
          "access.reader_setup_started",
          "access_reader",
          0,
          reason,
          null,
          { id: readerId, name, kind, resourceId, gatewayId },
        );
        return { id, readerId, status: "queued" };
      });
      res.status(201).json({ data }); // No Wi-Fi password or signing key in browser responses/audit.
    },
  );
  routes.post(
    "/admin/access/reader-setup/:id/cancel",
    configure,
    requireCsrf,
    async (req, res) => {
      if (!uuid.test(String(req.params.id)))
        throw new AppError(400, "INVALID_SETUP", "Choose a current setup.");
      await transaction(pool, async (db) => {
        const setup = new ReaderSetupRepository(db);
        const job = await setup.lockJob(req.params.id);
        if (!job) throw new AppError(404, "NOT_FOUND", "Setup not found.");
        if (job.status === "complete")
          throw new AppError(
            409,
            "SETUP_COMPLETE",
            "This reader is already connected. Manage it from Readers.",
          );
        if (["cancelled", "expired", "failed"].includes(job.status)) return;
        await setup.cancelJob(job.id);
        await setup.disableReader(job.reader_id);
        await new StaffModel(db, timeZone).audit(
          authState(res).user.id,
          null,
          "access.reader_setup_cancelled",
          "access_reader",
          0,
          "Cancelled reader setup",
          null,
          { id: job.reader_id },
        );
      });
      res.json({ data: { cancelled: true } });
    },
  );
  return routes;
}
