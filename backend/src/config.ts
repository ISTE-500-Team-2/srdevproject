// Validates environment settings once at startup. Production must explicitly configure its origin
// and cannot enable sample-account login.

import {readDeviceConfig,type DeviceConfig} from './deviceAccess.js';
import {readStudioStripeConfig,type StudioStripeConfig} from './studios/stripe.js';
import { readJwtKey } from './jwtKey.js';
import { readNotificationConfig, type NotificationConfig } from './notifications/config.js';
import { validTimeZone } from './notifications/reminderTiming.js';
import { isIP } from 'node:net';

export interface AppConfig {
  devices?: DeviceConfig;
  studioStripe?: StudioStripeConfig;
  port: number;
  host: string;
  secureCookies: boolean;
  demoLogin: boolean;
  allowedOrigins: string[];
  timeZone: string;
  jwtKey: Uint8Array;
  accessTokenSeconds?: number;
  refreshTokenSeconds?: number;
  notifications?: NotificationConfig;
  brevoWebhookToken?: string;
  /** Express 'trust proxy': how many proxy hops, or which proxy addresses, may name the client. */
  trustProxy?: number | string[];
}

function lifetime(name: string, fallback: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
/**
 * The proxies in front of the app, so sign-in limits count each visitor rather than the proxy.
 * A hop count, or addresses/subnets (Express's loopback, linklocal and uniquelocal names too).
 * Unset trusts no proxy. Trusting every hop ('true') would let any client pick its own address.
 */
function trustProxy(): number | string[] | undefined {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) throw new Error('Invalid TRUST_PROXY');
    return hops;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !['loopback', 'linklocal', 'uniquelocal'].includes(entry) && !isIP(entry.replace(/\/\d{1,3}$/, ''))))
    throw new Error('Invalid TRUST_PROXY');
  return entries;
}
/**
 * Fail startup on invalid security/runtime settings rather than running with an unintended
 * production configuration.
 */
export function readConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PORT');
  const production = process.env.NODE_ENV === 'production';
  const brevoWebhookToken = process.env.BREVO_WEBHOOK_TOKEN;
  if (brevoWebhookToken && brevoWebhookToken.length < 32)
    throw new Error('BREVO_WEBHOOK_TOKEN must contain at least 32 characters');
  const demoLogin = process.env.ENABLE_DEMO_LOGIN === 'true';
  if (production && demoLogin)
    throw new Error('Demo login is forbidden in production');
  if (production && !process.env.APP_ORIGIN)
    throw new Error('APP_ORIGIN is required in production');
  // A blank or mistyped zone would start a healthy-looking server whose date pages all fail.
  const timeZone = process.env.APP_TIME_ZONE?.trim() || 'America/New_York';
  if (!validTimeZone(timeZone))
    throw new Error('APP_TIME_ZONE must be an IANA time zone name, such as America/New_York');
  return {
    devices: readDeviceConfig(),
    studioStripe: readStudioStripeConfig(),
    notifications: readNotificationConfig(),
    brevoWebhookToken,
    jwtKey: readJwtKey(),
    accessTokenSeconds: lifetime("JWT_ACCESS_SECONDS",900,3600),
    refreshTokenSeconds: lifetime("JWT_REFRESH_SECONDS",2592000,7776000),
    port,
    host: process.env.HOST ?? '127.0.0.1',
    secureCookies: production,
    demoLogin,
    timeZone,
    trustProxy: trustProxy(),
    allowedOrigins: process.env.APP_ORIGIN
      ? [new URL(process.env.APP_ORIGIN).origin]
      : [
          `http://localhost:${port}`,
          `http://127.0.0.1:${port}`,
          'http://localhost:5173',
          'http://127.0.0.1:5173',
        ],
  };
}
