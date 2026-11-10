/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // dist/.vite/manifest.json lists the content-hashed build output. The backend
  // reads it to cache exactly those files forever; public/assets files keep
  // their names across releases and must not be.
  // One stylesheet, loaded up front: page code is split into lazily loaded areas
  // (see src/areas), but keeping CSS whole preserves today's cascade order exactly.
  build: { manifest: true, cssCodeSplit: false },
  server: {
    port: 5173,
    proxy: { '/api': process.env.DEV_API_TARGET || 'http://127.0.0.1:8080' },
  },
  preview: {
    port: 4173,
  },
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
});
