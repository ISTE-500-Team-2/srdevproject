import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import express from 'express';

const require = createRequire(import.meta.url);

test('compressed JSON with trailing bytes cannot terminate the HTTP process', async () => {
  const app = express();
  app.use(express.json());
  app.post('/probe', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(((error: unknown, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(400).json({ rejected: Boolean(error) });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  try {
    const payload = Buffer.concat([gzipSync('{"ok":true}'), Buffer.from('trailing-invalid-data')]);
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/probe', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': payload.length } }, (res) => {
        res.resume();
        res.once('end', resolve);
      });
      req.once('error', reject);
      req.end(payload);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('IPv4-mapped IPv6 subnet cannot trust arbitrary IPv4 proxy peers', () => {
  const proxyaddr = require('proxy-addr') as { compile: (range: string) => (address: string) => boolean };
  const trust = proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.7'), false);
});
