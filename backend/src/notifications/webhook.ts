import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppError } from '../domain.js';
import { transaction } from '../db.js';

const eventTypes = new Set(['request','delivered','hard_bounce','soft_bounce','blocked','spam','invalid_email','deferred','error','unsubscribed','opened','unique_opened','click','unique_proxy_open']);
/** Brevo supports bearer authorization on webhook callbacks. Never use URL secrets. */
export function brevoWebhook(pool: Pool, secret?: string) {
  return async (req: Request, res: Response) => {
    if (!secret) throw new AppError(503, 'WEBHOOK_DISABLED', 'Webhook not configured.');
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
    const supplied = createHash('sha256').update(req.get('Authorization') ?? '').digest();
    if (!timingSafeEqual(expected, supplied)) throw new AppError(401,'UNAUTHORIZED','Invalid webhook authentication.');
    const batch: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    if (!batch.length || batch.length > 50) throw new AppError(400,'INVALID_WEBHOOK','Invalid event batch.');
    const events = batch.map(raw => {
      if (!raw || typeof raw !== 'object') throw new AppError(400,'INVALID_WEBHOOK','Invalid event.');
      const item = raw as Record<string,unknown>;
      const type = item.event;
      const message = item['message-id'];
      const timestamp = item.ts_event ?? item.ts;
      if (typeof type !== 'string' || !eventTypes.has(type) || typeof message !== 'string' || !message.trim() || message.length>512 || /[\r\n]/.test(message) || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp<=0)
        throw new AppError(400,'INVALID_WEBHOOK','Invalid event fields.');
      const occurredAt = new Date(timestamp*1000);
      if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime()>Date.now()+300_000) throw new AppError(400,'INVALID_WEBHOOK','Invalid event timestamp.');
      const messageId = message.replace(/^<|>$/g,'');
      const eventKey = createHash('sha256').update(JSON.stringify([messageId,type,timestamp])).digest('hex');
      return {type,messageId,eventKey,occurredAt};
    });
    await transaction(pool,async db => {
      for (const event of events) {
        // Save even if the callback beats the send response/outbox update.
        await db.query(`INSERT INTO app_brevo_delivery_event(event_key,provider_message_id,event_type,occurred_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(event_key) DO NOTHING`,[event.eventKey,event.messageId,event.type,event.occurredAt]);
        if (event.type==='unsubscribed') {
          // Only known outbox ownership, never trust callback recipient input.
          await db.query(`INSERT INTO app_notification_preferences(userid,enabled)
            SELECT DISTINCT userid,false FROM app_notification_outbox WHERE trim(both '<>' from provider_message_id)=$1
            ON CONFLICT(userid) DO UPDATE SET enabled=false,updated_at=NOW()`,[event.messageId]);
        }
      }
    });
    res.sendStatus(204);
  };
}
