import type { Pool } from 'pg';
import type { NotificationConfig } from './config.js';
import { BrevoTransport, NotificationTransportError } from './transport.js';
import { renderNotification, type NotificationKind } from './templates.js';
import { runNotificationBatch, NotificationSendError } from './worker.js';
import { scheduleExpirationNotifications } from './scheduler.js';

/** A single local tick at a time; database leases coordinate multiple processes. */
export function startNotificationRuntime(pool: Pool, config?: NotificationConfig) {
  if (!config) return { stop: async () => {} };
  const transport = new BrevoTransport(config);
  let stopped = false;
  let pending: Promise<void> | undefined;
  let lastScan = 0;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      // Initial scan plus daily scan. Dispatch still runs once per configured interval.
      if (Date.now() - lastScan >= 24 * 60 * 60 * 1000) {
        await scheduleExpirationNotifications(pool);
        lastScan = Date.now();
      }
      await runNotificationBatch(pool, async job => {
        try {
          const content = renderNotification(job.kind as NotificationKind, {...job.payload, timeZone: job.timeZone}, {
            recipientEmail: job.email,
            recipientName: job.firstName,
            senderName: config.senderName,
            senderEmail: config.senderEmail,
            postalAddress: config.postalAddress,
            preferencesUrl: `${config.appOrigin}/profile`,
          });
          return await transport.send({ recipientEmail: job.email, recipientName: job.firstName, ...content });
        } catch (error) {
          if (error instanceof NotificationTransportError)
            throw new NotificationSendError('Email provider request was not confirmed', {
              retryable: error.classification === 'transient',
              ambiguous: error.classification === 'ambiguous',
              retryAfterMs: error.retryAfterMs,
            });
          throw error;
        }
      });
    })().catch(() => {
      // Never log payloads, credentials, recipient addresses or provider response bodies.
      console.error('Notification worker tick failed; retrying on the next interval');
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, config.intervalMs);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
