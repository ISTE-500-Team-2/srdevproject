// Training notices (FR-048): a member's own booking refused for missing training, and a
// certification staff revoked. Both respect the member's email opt-out through the outbox.

import type { Pool } from 'pg';
import { transaction, type Database } from '../db.js';
import { AppError } from '../domain.js';
import { businessToday } from '../businessDate.js';
import { errorIdentifier } from '../logSafety.js';
import { enqueueNotification } from './store.js';

/**
 * Run a member's own booking work; if it is refused for missing or expired training, queue the
 * training notice in its own transaction and rethrow the refusal unchanged. The refused booking's
 * transaction has already rolled back, so the notice can't ride in it, and a notice that fails to
 * queue is logged rather than replacing the refusal the member sees.
 */
export async function noticeCertificationRefusal<T>(pool: Pool, timeZone: string,
  attempt: { memberId: number; equipmentId: number | null }, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (attempt.equipmentId !== null && error instanceof AppError && error.code === 'CERTIFICATION_REQUIRED')
      await transaction(pool, db => queueCertificationRequired(db, attempt.memberId, attempt.equipmentId!, timeZone))
        .catch((failure: unknown) => console.error('Training notice not queued', errorIdentifier(failure)));
    throw error;
  }
}

/** One notice per member, certification and studio day, however many times they try to book. */
async function queueCertificationRequired(db: Database, userId: number, equipmentId: number, timeZone: string) {
  const item = (await db.query<{ equipmentName: string; certId: number; certificationName: string }>(
    `SELECT e.name AS "equipmentName",c.certid AS "certId",c.name AS "certificationName"
     FROM equipment e JOIN certifications c ON c.certid=e.certid WHERE e.equipmentid=$1`, [equipmentId])).rows[0];
  if (!item) return;
  await enqueueNotification(db, {
    userId,
    kind: 'certification_required',
    dedupeKey: `certification-required:${userId}:${item.certId}:${businessToday(timeZone)}`,
    payload: {
      equipmentName: item.equipmentName,
      certificationName: item.certificationName,
      instructions: `Register for a ${item.certificationName} class on the Classes page. Once your instructor records your training, you can book ${item.equipmentName}. Already trained? Your certification may have expired, so check it under Certifications or ask staff.`,
    },
  });
}

/**
 * The member's notice that staff revoked a certification. Staff reasons stay private, as for photo
 * removal and account changes: the email names the certification and says to contact the studio.
 */
export async function queueCertificationRevoked(db: Database, record: { userid: number; certid: number; usercertid: number; revision: number }) {
  const name = (await db.query<{ name: string }>('SELECT name FROM certifications WHERE certid=$1', [record.certid])).rows[0]?.name;
  await enqueueNotification(db, {
    userId: record.userid,
    kind: 'certification_revoked',
    dedupeKey: `certification-revoked:${record.usercertid}:${record.revision}`,
    payload: { certificationName: name ?? null },
  });
}
