import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

// React/jsdom calls the real Express HTTP stack, backed by a fresh PostgreSQL DB.
// The cookie jar stays inside this harness, like a browser-owned HttpOnly cookie.
export async function createBrowserBridge() {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw new Error(
      'Explicit isolated PostgreSQL test configuration is required.',
    );
  const database = 'arbor_ui_' + randomBytes(6).toString('hex') + '_mvc_test';
  const admin = new Pool({ connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE DATABASE "${database}"`);
  const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
  try {
    await initializeDemo(pool);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
    throw error;
  }
  const app = createApp(pool, {
    // jsdom has a different Uint8Array realm from Node's Buffer subclass.
    jwtKey: new Uint8Array(randomBytes(32)),
    port: 8080,
    host: '127.0.0.1',
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: ['http://localhost:8080'],
    timeZone: 'America/New_York',
  });
  // Keep one HTTP listener alive while React issues concurrent session/catalog
  // requests. Supertest's per-request auto-listener can close a sibling request.
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = request.agent(server);
  let directToken = '';
  return {
    pool,
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.startsWith('/api/'))
        throw new Error(
          'Only application API requests are supported in this harness.',
        );
      const method = (init.method ?? 'GET').toLowerCase();
      let call =
        method === 'get'
          ? agent.get(url)
          : method === 'post'
            ? agent.post(url)
            : method === 'patch'
              ? agent.patch(url)
              : null;
      if (!call) throw new Error('Unsupported test method.');
      if (directToken && !new Headers(init.headers).has('Accept')) call = call.set('Authorization','Bearer '+directToken);
      call = call.set('Origin', 'http://localhost:8080');
      const headers = new Headers(init.headers);
      headers.forEach((value, key) => call!.set(key, value));
      if (init.body) call = call.send(String(init.body));
      const response = await call;
      if (response.body?.data?.accessToken) directToken=response.body.data.accessToken;
      if (url==='/api/auth/logout' && response.status===204) directToken='';
      return new Response(
        response.status === 204 ? null : JSON.stringify(response.body),
        {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.end();
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
    },
  };
}
