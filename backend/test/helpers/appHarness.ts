import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from './confirmation.js';

export type TestApp = ReturnType<typeof createApp>;

/** Registration body fields that differ between suites; email, password, phone and birth date are generated. */
export interface SignupProfile {
  firstName: string;
  lastName: string;
  /** Sent to prove the server ignores a self-assigned role. */
  role?: string;
}

/**
 * One suite's fresh, demo-seeded PostgreSQL database plus the HTTP listeners
 * serving it. Never points at an existing database; teardown drops it.
 */
export class DisposableApp {
  readonly database: string;
  readonly pool: Pool;
  readonly config: AppConfig = {
    jwtKey: randomBytes(32),
    port: 8080,
    host: '127.0.0.1',
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: ['http://localhost:8080'],
    timeZone: 'America/New_York',
  };
  private readonly admin = new Pool({ connectionTimeoutMillis: 5000 });
  private readonly listeners = new Set<Server>();
  private current: Server | undefined;
  private created = false;

  constructor(prefix: string) {
    this.database = prefix + randomBytes(6).toString('hex') + '_mvc_test';
    this.pool = new Pool({ database: this.database, connectionTimeoutMillis: 5000, max: 10 });
  }

  /** Creates and seeds the database. Call from before(). */
  async setup() {
    if (!process.env.PGHOST || process.env.DATABASE_URL)
      throw new Error('Use explicit PGHOST/PGPORT/PGUSER/PGDATABASE for an isolated PostgreSQL test server.');
    await this.admin.query(`CREATE DATABASE "${this.database}"`);
    this.created = true;
    await initializeDemo(this.pool);
    // Scheduling/access tests use free equipment; card checkout has separate payment coverage.
    await this.pool.query('UPDATE equipment SET hourlyrate=0');
  }

  /** The listener new clients connect to. */
  get server(): Server {
    if (!this.current) throw new Error('No test server is listening; call start() first.');
    return this.current;
  }

  /** Starts another listener (by default for a new app on this database) that is closed at teardown. */
  async listen(app: TestApp = createApp(this.pool, this.config)) {
    const listener = app.listen(0, '127.0.0.1');
    this.listeners.add(listener);
    await once(listener, 'listening');
    return listener;
  }

  /** Serves `app` (by default a new app on this database) as the listener new clients use. */
  async start(app?: TestApp) {
    this.current = await this.listen(app);
    return this.current;
  }

  /** Closes the current listener once its connections finish, then starts a new app. */
  async restart() {
    const previous = this.current;
    if (previous) {
      await new Promise<void>(resolve => previous.close(() => resolve()));
      this.listeners.delete(previous);
    }
    return this.start();
  }

  /** A signed-out client of the current listener. */
  client(profile: SignupProfile) {
    return new TestClient(this.server, this.pool, profile);
  }

  /** Call from after(): closes every listener, then drops the database. */
  async teardown() {
    await Promise.all([...this.listeners].map(listener => new Promise<void>(resolve => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    })));
    await this.pool.end();
    if (this.created) await this.admin.query(`DROP DATABASE "${this.database}"`);
    await this.admin.end();
  }
}

/** A browser-like API client: adopts the bearer token and CSRF token from each sign-in. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  private csrf = '';
  private userId = 0;
  private token = '';
  private email = '';
  private password = '';

  constructor(server: Server, private readonly pool: Pool, private readonly profile: SignupProfile) {
    this.agent = request.agent(server);
  }

  get id() {
    return this.userId;
  }

  /** The bearer access token from the latest sign-in. */
  get accessToken() {
    return this.token;
  }

  private accept(res: request.Response) {
    this.agent.set('Authorization', 'Bearer ' + res.body.data.accessToken);
    this.csrf = res.body.data.csrfToken;
    this.userId = res.body.data.user.id;
    this.token = res.body.data.accessToken;
  }

  async demo(role = 'member') {
    const res = await this.agent.post('/api/auth/demo').send({ role });
    assert.equal(res.status, 200);
    this.accept(res);
    return res;
  }

  /** Signs up a new account, confirms it from the outbox and signs in. */
  async register() {
    const email = randomUUID() + '@example.invalid',
      password = `A!${randomBytes(24).toString('hex')}`;
    let res = await this.agent.post('/api/auth/register').send({
      ...this.profile,
      email,
      password,
      phone: '0000000000',
      dob: '2000-01-01',
    });
    assert.equal(res.status, 202);
    res = await this.agent.post('/api/auth/confirm').send({ token: await confirmationToken(this.pool, email) });
    assert.equal(res.status, 200);
    this.accept(res);
    this.email = email;
    this.password = password;
    return { email, password, res };
  }

  /** Signs in (by default as the registered account); adopts the session only on success. */
  async login(email = this.email, password = this.password) {
    const res = await this.agent.post('/api/auth/login').send({ email, password });
    if (res.status === 200) this.accept(res);
    return res;
  }

  adoptCsrf(token: string) {
    this.csrf = token;
  }

  refresh() {
    return this.agent.post('/api/auth/refresh').set('X-CSRF-Token', this.csrf).send({});
  }

  get(path: string) {
    return this.agent.get('/api' + path);
  }

  post(path: string, body: string | object = {}) {
    return this.agent.post('/api' + path).set('X-CSRF-Token', this.csrf).send(body);
  }

  patch(path: string, body: string | object) {
    return this.agent.patch('/api' + path).set('X-CSRF-Token', this.csrf).send(body);
  }
}
