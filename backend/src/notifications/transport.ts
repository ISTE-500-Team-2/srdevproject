/** https://developers.brevo.com/reference/send-transac-email */
export type TransportFailure = 'transient' | 'permanent' | 'ambiguous';
export class NotificationTransportError extends Error {
  constructor(public readonly classification: TransportFailure, public readonly status?: number,
    public readonly retryAfterMs?: number) {
    super(`Notification provider ${classification} failure${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'NotificationTransportError';
  }
}
export interface BrevoTransportConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  replyToEmail: string;
  timeoutMs?: number;
}
export interface NotificationMessage {
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  htmlContent: string;
  textContent: string;
}

export class BrevoTransport {
  constructor(private readonly config: BrevoTransportConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(message: NotificationMessage): Promise<{messageId: string}> {
    const c = this.config;
    if (![c.apiKey, c.senderEmail, c.senderName, c.replyToEmail, message.recipientEmail, message.subject].every(v => v?.trim()) ||
      [c.senderEmail, c.senderName, c.replyToEmail, message.recipientEmail, message.subject].some(v => /[\r\n]/.test(v)) ||
      !Number.isFinite(c.timeoutMs ?? 10_000) || (c.timeoutMs ?? 10_000) <= 0) {
      throw new NotificationTransportError('permanent');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race also bounds injected/buggy fetch implementations that ignore AbortSignal.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NotificationTransportError('ambiguous')); }, c.timeoutMs ?? 10_000);
    });
    const attempt = async (): Promise<{messageId: string}> => {
      const response = await this.fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'api-key': c.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: c.senderEmail, name: c.senderName },
          replyTo: { email: c.replyToEmail, name: c.senderName },
          to: [{ email: message.recipientEmail, ...(message.recipientName ? { name: message.recipientName } : {}) }],
          subject: message.subject, htmlContent: message.htmlContent, textContent: message.textContent,
        }),
      });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 :
          retry ? Math.max(0, Date.parse(retry) - Date.now()) : undefined;
        // Don't retain provider response bodies: errors may echo recipient/content/secrets.
        const classification = response.status === 429 ? 'transient' :
          response.status >= 500 || response.status === 408 ? 'ambiguous' : 'permanent';
        throw new NotificationTransportError(classification, response.status,
          retryMs !== undefined && Number.isFinite(retryMs) ? retryMs : undefined);
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('messageId' in body) ||
        typeof body.messageId !== 'string' || !body.messageId.trim() || body.messageId.length > 512 || /[\r\n]/.test(body.messageId)) {
        // Request may already have been accepted: do not automatically resend.
        throw new NotificationTransportError('ambiguous', response.status);
      }
      return { messageId: body.messageId };
    };
    try { return await Promise.race([attempt(), timeout]); }
    catch (error) {
      if (error instanceof NotificationTransportError) throw error;
      throw new NotificationTransportError('ambiguous');
    } finally { if (timer) clearTimeout(timer); }
  }
}
