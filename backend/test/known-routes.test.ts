import assert from 'node:assert/strict';
import { test } from 'node:test';
import express, { Router, type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { knownRoutesOnly, routePaths } from '../src/middleware/knownRoutes.js';

function api() {
  const inner = Router();
  inner.get('/classes/:id', (_req, res) => { res.json({ data: 'class' }); });
  const routes = Router();
  routes.post('/auth/login', (_req, res) => { res.json({ data: 'login' }); });
  routes.use((_req, _res, next) => next(Object.assign(new Error('auth'), { status: 401 })));
  routes.use('/admin', (_req, _res, next) => next());
  routes.use(inner);
  routes.get('/admin/users', (_req, res) => { res.json({ data: 'users' }); });
  return routes;
}

function app() {
  const routes = api();
  const server = express();
  server.use('/api', knownRoutesOnly(routes, (_req, res) => { res.status(404).json({ error: 'missing' }); }), routes);
  const onError: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status ?? 500).json({ error: error.message }); };
  server.use(onError);
  return server;
}

test('route paths include root-mounted routers and skip path-mounted gates', () => {
  assert.deepEqual(routePaths(api()), ['/auth/login', '/classes/:id', '/admin/users']);
});

test('unknown paths are 404 before authentication; known paths still reach it', async () => {
  const server = app();
  assert.equal((await request(server).get('/api/nope')).status, 404);
  assert.equal((await request(server).get('/api/admin/nope')).status, 404);
  assert.equal((await request(server).get('/api/classes/7/extra')).status, 404);
  assert.equal((await request(server).get('/api/classes/7')).status, 401);
  assert.equal((await request(server).get('/api/admin/users')).status, 401);
  // Known path, other method: still behind authentication, as before.
  assert.equal((await request(server).delete('/api/admin/users')).status, 401);
  assert.equal((await request(server).post('/api/auth/login')).status, 200);
});

test('a router mounted under a path is refused instead of silently hidden', () => {
  const routes = Router();
  const nested = Router();
  nested.get('/x', (_req, res) => { res.end(); });
  routes.use('/nested', nested);
  assert.throws(() => routePaths(routes), /Mount API routers at the root/);
});
