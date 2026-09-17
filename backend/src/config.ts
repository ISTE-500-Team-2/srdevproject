import { readJwtKey } from './jwtKey.js';

export interface AppConfig {
  port: number;
  host: string;
  secureCookies: boolean;
  demoLogin: boolean;
  allowedOrigins: string[];
  timeZone: string;
  jwtKey: Uint8Array;
  accessTokenSeconds?: number;
  refreshTokenSeconds?: number;
}

function lifetime(name: string, fallback: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export function readConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PORT');
  const production = process.env.NODE_ENV === 'production';
  const demoLogin = process.env.ENABLE_DEMO_LOGIN === 'true';
  if (production && demoLogin)
    throw new Error('Demo login is forbidden in production');
  if (production && !process.env.APP_ORIGIN)
    throw new Error('APP_ORIGIN is required in production');
  return {
    jwtKey: readJwtKey(),
    accessTokenSeconds: lifetime("JWT_ACCESS_SECONDS",900,3600),
    refreshTokenSeconds: lifetime("JWT_REFRESH_SECONDS",2592000,7776000),
    port,
    host: process.env.HOST ?? '127.0.0.1',
    secureCookies: production,
    demoLogin,
    timeZone: process.env.APP_TIME_ZONE ?? 'America/New_York',
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
