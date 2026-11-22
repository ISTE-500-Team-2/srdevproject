// Browser integration tests use the real backend bridge and isolated PostgreSQL; unit-test
// configuration remains in vite.config.ts.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/integration/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./test/integration/setup.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    // The in-process backend hashes test passwords at cost 4 (~1 ms) instead of 12 (~225 ms).
    env: { ARBOR_PASSWORD_COST: process.env.ARBOR_PASSWORD_COST ?? '4' },
  },
});
