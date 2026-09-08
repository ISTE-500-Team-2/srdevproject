import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { AppError } from './domain.js';
import { checkOrigin } from './middleware/auth.js';
import { apiRoutes } from './routes.js';

export function createApp(
  pool: Pool,
  config: AppConfig,
  frontendDirectory?: string,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    express.json({ limit: '96kb' }),
    checkOrigin(config),
    apiRoutes(pool, config),
  );
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'API endpoint not found.')),
  );
  if (
    frontendDirectory &&
    existsSync(path.join(frontendDirectory, 'index.html'))
  ) {
    app.use(express.static(frontendDirectory, { index: false }));
    app.get('/{*path}', (_req, res) =>
      res.sendFile(path.join(frontendDirectory, 'index.html')),
    );
  }
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof AppError) {
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
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
      res
        .status(409)
        .json({
          error: {
            code: 'RESERVATION_CONFLICT',
            message:
              'That equipment is already reserved for part of this time.',
          },
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
