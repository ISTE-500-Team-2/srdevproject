import { ReaderRegistry } from './readerRegistry.js';
import {readerSetupPoll} from './readerSetup.js';
import {deviceDecision} from './deviceAccess.js';
import {studioWebhook} from './studios/routes.js';
import { auditContext, auditedPool } from './auditContext.js';
import compression from 'compression';
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { AppError } from './domain.js';
import { checkOrigin } from './middleware/auth.js';
import { apiRoutes } from './routes.js';
import { knownRoutesOnly } from './middleware/knownRoutes.js';
import { brevoWebhook } from './notifications/webhook.js';

// Token-bearing auth responses (BREACH), signed NFC reader traffic and provider
// webhooks keep their exact wire format. Routing is case-insensitive, so match
// the path the same way, and also its decoded form. The filter runs when the
// headers go out, inside the /api mount, so req.path has lost its prefix there;
// parse originalUrl so absolute-form targets (http://host/api/auth/...) match too.
const uncompressedApi = /^\/api\/(?:auth|devices|webhooks)(?:\/|$)/i;
function shouldCompress(req: Request, res: Response) {
  // A byte range addresses the stored file; compressing it would mislabel the range.
  if (req.headers.range) return false;
  let pathname: string;
  try { pathname = new URL(req.originalUrl, 'http://origin.invalid').pathname; }
  catch { return false; }
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* answered 400 elsewhere */ }
  if (uncompressedApi.test(pathname) || uncompressedApi.test(decoded)) return false;
  return compression.filter(req, res);
}

// Vite's manifest lists the content-hashed build output (JS, CSS and the fonts
// and images they import). Those names change whenever their bytes do, so they
// can be cached forever. Files copied from frontend/public/assets keep their
// names across releases and are not listed. No manifest: cache nothing forever.
function hashedBuildFiles(frontendDirectory: string) {
  const files = new Set<string>();
  try {
    const manifest = JSON.parse(readFileSync(path.join(frontendDirectory, '.vite', 'manifest.json'), 'utf8')) as
      Record<string, { file?: string; css?: string[]; assets?: string[] }>;
    for (const chunk of Object.values(manifest))
      for (const file of [chunk.file ?? [], chunk.css ?? [], chunk.assets ?? []].flat())
        if (file.startsWith('assets/')) files.add(path.resolve(frontendDirectory, file));
  } catch { /* development or a hand-built directory */ }
  return files;
}

export function createApp(
  pool: Pool,
  config: AppConfig,
  frontendDirectory?: string,
) {
  const app = express();
  pool = auditedPool(pool);
  const readers = new ReaderRegistry(pool,config.devices);
  app.use((_req, _res, next) => auditContext.run({}, next));
  app.disable('x-powered-by');
  app.use(compression({ filter: shouldCompress }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.post('/api/devices/decision',express.raw({type:'application/json',limit:'2kb'}),deviceDecision(pool,config.timeZone,config.devices,readers));
  app.post('/api/devices/setup/poll',express.raw({type:'application/json',limit:'16kb'}),readerSetupPoll(pool,readers));
  app.post('/api/webhooks/stripe-studios',express.raw({type:'application/json',limit:'96kb'}),studioWebhook(pool,config.timeZone,config.studioStripe));
  app.use(
    '/api/webhooks/brevo',
    express.json({ limit: '64kb' }),
  );
  // Provider callbacks authenticate with their own bearer token, not browser CSRF.
  app.post('/api/webhooks/brevo', brevoWebhook(pool, config.brevoWebhookToken));
  const api = apiRoutes(pool, config, readers);
  const apiNotFound: RequestHandler = (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'API endpoint not found.'));
  app.use(
    '/api',
    knownRoutesOnly(api, apiNotFound),
    express.json({ limit: '96kb' }),
    checkOrigin(config),
    api,
  );
  app.use('/api', apiNotFound);
  if (
    frontendDirectory &&
    existsSync(path.join(frontendDirectory, 'index.html'))
  ) {
    // Hashed build output never changes meaning; every other file and the app
    // shell are revalidated so a new release shows up on the next load.
    const immutable = hashedBuildFiles(frontendDirectory);
    app.use(express.static(frontendDirectory, {
      index: false,
      setHeaders: (res, filePath) => {
        res.set('Cache-Control', immutable.has(path.resolve(filePath))
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      },
    }));
    // Only page routes get the app shell. Files (an extension in the last
    // segment) and dot paths such as /.env are real 404s for crawlers, scanners
    // and the release edge's previous-asset fallback.
    app.get('/{*path}', (req, res) => {
      // Decode the whole path first, so /%2eenv, /missing%2ejs and an encoded slash
      // hiding a dot segment are judged like their plain forms. Malformed escapes
      // never get here: Express fails to decode them and onError answers 400.
      const segments = decodeURIComponent(req.path).split('/');
      if (segments.some((s) => s.startsWith('.')) || segments.at(-1)!.includes('.'))
        return res.status(404).type('text/plain').send('Not found');
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(frontendDirectory, 'index.html'));
    });
  }
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    // Static serving sets caching and validators before it can fail; an error
    // must never be cached (least of all for a year) or look like the file.
    if (!res.headersSent) {
      for (const header of ['ETag', 'Last-Modified', 'Content-Range', 'Accept-Ranges']) res.removeHeader(header);
      res.set('Cache-Control', 'no-store');
    }
    if (error instanceof AppError) {
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } });
      return;
    }
    if (error?.code === '23505') {
      res
        .status(409)
        .json({
          error: {
            code: 'ALREADY_EXISTS',
            message: 'A record with those details already exists.',
          },
        });
      return;
    }
    if (error?.code === '23P01') {
      const isCooldown =
        error?.constraint === 'app_equipment_reservation_user_cooldown' ||
        error?.constraint === 'app_room_reservation_user_cooldown';
      res
        .status(409)
        .json({
          error: {
            code: isCooldown
              ? 'RESERVATION_COOLDOWN'
              : 'RESERVATION_CONFLICT',
            message: isCooldown
              ? 'Leave a cooldown between reservations for the same resource.'
              : 'That resource is already reserved for part of this time.',
          },
        });
      return;
    }
    // Express could not decode a %-escape in the path (e.g. /api/users/%E0).
    // That is a bad request, not a server failure worth logging.
    if (error instanceof URIError && (error as URIError & { status?: number }).status === 400) {
      res.status(400).json({
        error: { code: 'INVALID_PATH', message: 'The request path is not valid.' },
      });
      return;
    }
    if (
      error?.type === 'entity.parse.failed' ||
      error?.type === 'entity.too.large'
    ) {
      res
        .status(error.type === 'entity.too.large' ? 413 : 400)
        .json({
          error: {
            code: 'INVALID_JSON',
            message: 'The request body is invalid or too large.',
          },
        });
      return;
    }
    // Static-file conditions the client asked for and cannot be met
    // (If-Match/If-Unmodified-Since, unsatisfiable Range) are client errors.
    if (error?.status === 412 || error?.status === 416) {
      if (error.status === 416 && error.headers?.['Content-Range'])
        res.set('Content-Range', error.headers['Content-Range']);
      res.status(error.status).type('text/plain').end(error.status === 412 ? 'Precondition failed' : 'Range not satisfiable');
      return;
    }
    // Never log request bodies, cookies, connection strings, or SQL parameter values.
    console.error('Request failed', {
      type: error?.constructor?.name,
      code: typeof error?.code === 'string' ? error.code : undefined,
    });
    res
      .status(500)
      .json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed. Please try again.',
        },
      });
  };
  app.use(onError);
  return app;
}
