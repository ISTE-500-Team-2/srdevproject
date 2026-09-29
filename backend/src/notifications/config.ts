export interface NotificationConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  replyToEmail: string;
  postalAddress: string;
  appOrigin: string;
  intervalMs: number;
}

/** Explicit opt-in: tests and demo stacks never accidentally contact Brevo. */
export function readNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationConfig | undefined {
  if (env.EMAIL_ENABLED !== 'true') return undefined;
  if (env.ENABLE_DEMO_LOGIN === 'true')
    throw new Error('Real email sending cannot be enabled with demo login');
  if (!env.BREVO_API_KEY?.trim()) throw new Error('BREVO_API_KEY is required when EMAIL_ENABLED=true');
  const origin = new URL(env.APP_ORIGIN ?? '');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('APP_ORIGIN must be an HTTP(S) application URL');
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
    throw new Error('Production email links require HTTPS APP_ORIGIN');
  const senderEmail = env.EMAIL_FROM ?? 'arborcollaboratory@yahoo.com';
  const replyToEmail = env.EMAIL_REPLY_TO ?? 'arborcollaboratory@yahoo.com';
  if (![senderEmail, replyToEmail].every(value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)))
    throw new Error('Invalid email sender or reply-to');
  const intervalMs = Number(env.EMAIL_WORKER_INTERVAL_MS ?? 60000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000)
    throw new Error('Invalid EMAIL_WORKER_INTERVAL_MS');
  return {
    apiKey: env.BREVO_API_KEY,
    senderEmail,
    replyToEmail,
    senderName: env.EMAIL_FROM_NAME ?? 'The Crafty Studio',
    postalAddress: env.EMAIL_POSTAL_ADDRESS ?? '1449 Wiseburg Road, White Hall, Maryland 21161',
    appOrigin: origin.origin,
    intervalMs,
  };
}
