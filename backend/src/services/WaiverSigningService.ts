import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError } from '../domain.js';
import { EligibilityModel } from '../models/EligibilityModel.js';
import { MemberModel } from '../models/MemberModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { queueEarlyExpiryReminder, queueUntextedWaiverSigned, queueWaiverSigned } from '../notifications/waiverNotices.js';
import {
  completedWaiverText, participantSignatureField, serverWaiverValues, validateWaiverFields, waiverFormFields,
} from '../waiverForms.js';

export interface WaiverSigner { id: number; firstName: string; lastName: string }
export interface WaiverSigningInput { accepted?: unknown; formValues?: unknown; guardianConsent?: unknown }

/** A member's explicit electronic agreement to a current required waiver. */
export class WaiverSigningService {
  constructor(private pool: Pool, private timeZone: string) {}

  /** Records the signature, its immutable copy and notices; returns the member's current waivers. */
  async sign(signer: WaiverSigner, waiverId: number, input: WaiverSigningInput) {
    const userId = signer.id;
    const signerName = `${signer.firstName} ${signer.lastName}`;
    if (input.accepted !== true)
      throw new AppError(400, 'CONSENT_REQUIRED', 'Explicit agreement is required.');
    await transaction(this.pool, async (db) => {
      // Snapshot the signed version in the same transaction as its signature.
      const waiver = (await db.query<{ name: string; version: string; description: string | null }>(
        'SELECT name,version,description FROM waiver WHERE waiverid=$1 FOR SHARE', [waiverId])).rows[0];
      // Checked under the row lock, so the waiver cannot be retired before the signature is written.
      // Publishing a newer version inserts a new row and is not blocked, as before.
      const current = await new EligibilityModel(db, this.timeZone).waivers(userId);
      if (!waiver || !current.some((w) => w.id === waiverId))
        throw new AppError(404, 'NOT_FOUND', 'This is not a current required waiver.');
      const description = waiver.description ?? '';
      const form = validateWaiverFields(description, input.formValues, input.guardianConsent, signerName);
      const signatureField = participantSignatureField(waiverFormFields(description));
      const signature = await new MemberModel(db).signWaiver(userId, waiverId);
      if (!signature) return;
      await new StaffModel(db, this.timeZone).audit(userId, userId, 'waiver.signed', 'waiver', waiverId,
        'Explicit electronic agreement', null,
        { signatureId: signature.id, signedAt: signature.signedAt, version: waiver.version });
      // Identity, version and signing time are recorded by the server, not the form.
      const values = form
        ? { ...form.values, ...serverWaiverValues(description, { memberId: userId, signerName, waiverVersion: waiver.version, signedAt: new Date(signature.signedAt), timeZone: this.timeZone }) }
        : null;
      const signed = {
        waiverId,
        waiverName: waiver.name,
        waiverVersion: waiver.version,
        waiverText: waiver.description,
        signature: form && signatureField ? `${form.values[signatureField.key]} (electronic agreement)` : `${signerName} (electronic agreement)`,
        signedAt: new Date(signature.signedAt).toISOString(),
      };
      const formPart = form && values ? {
        formValues: values,
        guardianConsent: form.guardianConsent,
        completedWaiverText: completedWaiverText(description, values, form.guardianConsent),
        memberId: userId,
        methodOfAcceptance: 'Electronic',
      } : null;
      const payload = formPart ? { ...signed, ...formPart } : signed;
      // The signed copy is a durable record, kept apart from the notification queue.
      await db.query(
        'INSERT INTO app_signed_waiver_copy(userwaiverid,userid,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(userwaiverid) DO NOTHING',
        [signature.id, userId, JSON.stringify(payload)],
      );
      if (formPart) await queueWaiverSigned(db, userId, signature.id, { ...signed, ...formPart });
      else if (signed.waiverText !== null) await queueWaiverSigned(db, userId, signature.id, { ...signed, waiverText: signed.waiverText });
      else await queueUntextedWaiverSigned(db, userId, signature.id, signed);
      await queueEarlyExpiryReminder(db, userId, waiver.name, signature.id, signature.signedAt, signature.expiresAt);
    });
    return new EligibilityModel(this.pool, this.timeZone).waivers(userId);
  }
}
