import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';

const config = readConfig();
const pool = createPool();
await pool.query('SELECT 1 FROM app_session LIMIT 1');
const frontend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend/dist',
);
const server = createApp(pool, config, frontend).listen(
  config.port,
  config.host,
  () => {
    console.log(
      `Collaboratory MVC listening on ${config.host}:${config.port}; demo login ${config.demoLogin ? 'enabled' : 'disabled'}`,
    );
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
