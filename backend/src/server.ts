// Process entry point: loads configuration, starts HTTP/background runtimes and releases resources
// on shutdown.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { startNotificationRuntime } from './notifications/runtime.js';
import { startPolicyRuntime } from './policyLifecycle.js';
import { EquipmentBilling } from './billing/equipment.js';
import { startEquipmentReconciliation } from './equipmentReconciliation.js';
import { StudioStripe } from './studios/stripe.js';

const config = readConfig();
const pool = createPool();
await pool.query('SELECT 1 FROM app_session LIMIT 1');
// Reports and bookings convert dates in SQL as well, so the database must know the zone too.
await pool.query('SELECT NOW() AT TIME ZONE $1', [config.timeZone]).catch((error) => {
  if (error?.code === '22023') throw new Error(`The database does not recognize APP_TIME_ZONE ${config.timeZone}`);
  throw error;
});
const notifications = startNotificationRuntime(pool, config.notifications);
const policies = startPolicyRuntime(pool);
const equipmentPayments = startEquipmentReconciliation(new EquipmentBilling(pool,
  config.studioStripe ? new StudioStripe(config.studioStripe) : undefined, config.timeZone));
const frontend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend/dist',
);
const server = createApp(pool, config, frontend).listen(
  config.port,
  config.host,
  () => {
    console.log(`Email delivery: ${config.notifications ? 'ON (Brevo worker; provider delivery is not guaranteed)' : 'OFF (signup confirmation cannot be delivered)'}`);
    console.log(
      `Collaboratory MVC listening on ${config.host}:${config.port}; demo login ${config.demoLogin ? 'enabled' : 'disabled'}`,
    );
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => void Promise.all([notifications.stop(), policies.stop(), equipmentPayments.stop()]).then(() => pool.end()).finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
