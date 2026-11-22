import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import express, { Router, type RequestHandler } from 'express';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { accessGuard, accessRequirement } from '../src/middleware/accessGuards.js';
import { apiRoutes } from '../src/routes.js';

// Every API route outside this list must name its access requirement where it is registered. These
// are the only ones a signed-out visitor may call; each carries its own proof (a token in the body,
// the refresh cookie) or serves nothing private. Keep it short: adding to it makes a route public.
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /config',
  'GET /auth/csrf',
  'POST /auth/login',
  'POST /auth/register',
  'POST /auth/confirm',
  'POST /auth/confirmation',
  'POST /auth/password-reset',
  'POST /auth/password-reset/check',
  'POST /auth/password-reset/confirm',
  'POST /auth/email-change/confirm',
  'POST /auth/demo',
  'POST /auth/refresh',
  'GET /equipment-images/:version',
  'GET /class-images/:version',
];

// Served by the app itself, before the API router: devices and providers sign their own requests.
const SELF_AUTHENTICATING_APP_ROUTES = [
  'POST /api/devices/decision',
  'POST /api/devices/setup/poll',
  'POST /api/webhooks/stripe-studios',
  'POST /api/webhooks/brevo',
];

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: Layer[] };
  slash?: boolean;
};
type RouteInfo = { key: string; path: string; requirements: (string | undefined)[] };

function routes(router: { stack: readonly unknown[] }): RouteInfo[] {
  return (router.stack as Layer[]).flatMap((layer) => {
    if (layer.route) {
      const { route } = layer;
      const requirements = route.stack.map((entry) => accessRequirement(entry.handle));
      return [route.path].flat().flatMap((path) =>
        Object.keys(route.methods).map((method) => ({ key: `${method.toUpperCase()} ${path}`, path, requirements })));
    }
    if (!Array.isArray(layer.handle?.stack)) return [];
    // A router under a path would hide its full paths; the API mounts every router at the root.
    assert.ok(layer.slash, 'Mount API routers at the root.');
    return routes(layer.handle as { stack: Layer[] });
  });
}

/** Why each route fails the rules, empty when every route declares its requirement. */
function problems(router: { stack: readonly unknown[] }, publicRoutes: readonly string[]): string[] {
  const found: string[] = [];
  for (const { key, path, requirements } of routes(router)) {
    if (publicRoutes.includes(key)) continue;
    // The last handler answers the request; a guard has to run before it.
    const guards = requirements.slice(0, -1).filter((requirement) => requirement !== undefined);
    if (!guards.length) found.push(`${key}: no access guard`);
    // The /admin prefix gate is a second line of defense, never a route's only staff check.
    else if (/^\/admin(\/|$)/i.test(path) && !guards.some((guard) => /^(staff|admin)\b/.test(guard!)))
      found.push(`${key}: relies on the /admin prefix for staff status`);
  }
  return found;
}

const config: AppConfig = {
  jwtKey: randomBytes(32),
  port: 8080,
  host: '127.0.0.1',
  secureCookies: false,
  demoLogin: true,
  allowedOrigins: ['http://localhost:8080'],
  timeZone: 'America/New_York',
};
// Building the routers never connects; nothing here sends a query.
const pool = new Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 1 });
after(() => pool.end());

test('the audit flags unguarded routes and routes that lean on the /admin prefix alone', () => {
  const tagged = accessGuard('staff', ((_req, _res, next) => next()) as RequestHandler);
  const permission = accessGuard('thing:read:global', ((_req, _res, next) => next()) as RequestHandler);
  const answer: RequestHandler = (_req, res) => { res.end(); };
  const inner = Router();
  inner.get('/me/forgotten', answer);
  const router = Router();
  router.get('/health', answer);
  router.use((_req, _res, next) => next());
  router.use('/admin', tagged);
  router.use(inner);
  router.get('/admin/prefix-only', answer);
  router.get('/admin/grant-only', permission, answer);
  router.get('/admin/fine', tagged, permission, answer);
  router.get('/me/fine', permission, answer);
  router.get('/me/guard-last', permission);
  assert.deepEqual(problems(router, ['GET /health']), [
    'GET /me/forgotten: no access guard',
    'GET /admin/prefix-only: no access guard',
    'GET /admin/grant-only: relies on the /admin prefix for staff status',
    'GET /me/guard-last: no access guard',
  ]);
});

test('every non-public API route declares its access requirement at registration', () => {
  const api = apiRoutes(pool, config);
  assert.deepEqual(problems(api, PUBLIC_ROUTES), []);
  // The list stays exact: a public route that is renamed or removed must leave the list too.
  const keys = new Set(routes(api).map((route) => route.key));
  assert.deepEqual(PUBLIC_ROUTES.filter((key) => !keys.has(key)), []);
});

test('public API routes carry no guard, so the list matches what is really open', () => {
  const open = routes(apiRoutes(pool, config))
    .filter((route) => route.requirements.every((requirement) => requirement === undefined))
    .map((route) => route.key);
  assert.deepEqual(open.sort(), [...PUBLIC_ROUTES].sort());
});

test('routes the app serves outside the API router are only the self-authenticating device and provider calls', () => {
  const app = createApp(pool, config) as express.Express & { router: { stack: unknown[] } };
  const appRoutes = (app.router.stack as Layer[]).flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []);
  assert.deepEqual(appRoutes.sort(), [...SELF_AUTHENTICATING_APP_ROUTES].sort());
});
