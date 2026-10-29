import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { Pool } from "pg";
import type { Database } from "./db.js";
import { AppError } from "./domain.js";

export interface Reader {
  id: string;
  secret: string;
  kind: "building" | "room" | "equipment";
  resourceId?: number;
}
export interface DeviceConfig {
  cardHashKey: string;
  readers: Reader[];
  setupGateways?: { id: string; name: string; secret: string }[];
}
export interface StoredReader extends Omit<Reader, "secret"> {
  name: string;
  resourceId: number;
  secretEncrypted: string;
  enabled: boolean;
  revision: number;
}
export const readerColumns = `id,name,kind,resource_id AS "resourceId",secret_encrypted AS "secretEncrypted",enabled,revision`;
export function cardIdentity(uid: unknown, c: DeviceConfig) {
  const value =
    typeof uid === "string" ? uid.replace(/[: -]/g, "").toUpperCase() : "";
  if (!/^(?:[A-F0-9]{8}|[A-F0-9]{14}|[A-F0-9]{20})$/.test(value))
    throw new AppError(
      400,
      "INVALID_UID",
      "Enter 8, 14 or 20 hexadecimal characters (4, 7 or 10 bytes). Spaces, colons and hyphens are allowed.",
    );
  return {
    hash: createHmac("sha256", c.cardHashKey).update(value).digest("hex"),
    last4: value.slice(-4),
  };
}
export function requireDeviceConfig(c?: DeviceConfig): DeviceConfig {
  if (!c)
    throw new AppError(
      503,
      "DEVICES_NOT_CONFIGURED",
      "NFC setup is incomplete. Ask the system administrator to configure the card security key.",
    );
  return c;
}

export class ReaderRegistry {
  private imported?: Promise<void>;
  constructor(
    private pool: Pool,
    readonly config?: DeviceConfig,
  ) {}
  private key() {
    return createHmac("sha256", requireDeviceConfig(this.config).cardHashKey)
      .update("reader-credentials-v1")
      .digest();
  }
  encrypt(secret: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }
  decrypt(value: string) {
    const bytes = Buffer.from(value, "base64"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        bytes.subarray(0, 12),
      );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  // Legacy environment entries seed the registry once. Admin edits always win,
  // including disabled readers, and existing installations need no credential reset.
  async ready() {
    if (!this.imported)
      this.imported = this.importLegacy().catch((error) => {
        this.imported = undefined;
        throw error;
      });
    await this.imported;
  }
  private async importLegacy() {
    for (const r of this.config?.readers ?? []) {
      await this.pool.query(
        `INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted)
        VALUES($1,$1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
        [r.id, r.kind, r.resourceId ?? 1, this.encrypt(r.secret)],
      );
    }
  }
  async list() {
    await this.ready();
    return (
      await this.pool
        .query(`SELECT r.id,r.name,r.kind,r.resource_id AS "resourceId",r.enabled,r.revision,
      r.last_seen_at AS "lastSeenAt",COALESCE(r.last_seen_at>NOW()-INTERVAL '45 seconds',false) AS online,
      COALESCE(b.name,rm.name,e.name,'Unavailable resource') AS "resourceName"
      FROM app_access_reader r
      LEFT JOIN building b ON r.kind='building' AND b.buildingid=r.resource_id
      LEFT JOIN room rm ON r.kind='room' AND rm.roomid=r.resource_id
      LEFT JOIN equipment e ON r.kind='equipment' AND e.equipmentid=r.resource_id
      ${this.config?.setupGateways?.length ? "WHERE NOT EXISTS (SELECT 1 FROM app_reader_setup_job j WHERE j.reader_id=r.id AND j.status<>'complete')" : ""}
      ORDER BY r.name,r.id`)
    ).rows;
  }
}
export async function accessResources(db: Database) {
  return (
    await db.query(`SELECT buildingid AS id,name,'building' AS kind FROM building
    UNION ALL SELECT roomid,name,'room' FROM room
    UNION ALL SELECT equipmentid,name,'equipment' FROM equipment ORDER BY kind,name,id`)
  ).rows;
}
export async function assertReaderTarget(
  db: Database,
  kind: unknown,
  id: number,
) {
  const table =
    kind === "building"
      ? "building"
      : kind === "room"
        ? "room"
        : kind === "equipment"
          ? "equipment"
          : null;
  if (!table)
    throw new AppError(
      400,
      "INVALID_READER",
      "Choose a building, room or equipment.",
    );
  if (
    !(
      await db.query(`SELECT 1 FROM ${table} WHERE ${table}id=$1 FOR SHARE`, [
        id,
      ])
    ).rowCount
  )
    throw new AppError(404, "NOT_FOUND", "Reader location not found.");
}
export function enrollmentId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AppError(
      400,
      "INVALID_ENROLLMENT",
      "Choose a current card scan.",
    );
  return value;
}
