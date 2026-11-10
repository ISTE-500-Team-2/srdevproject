/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // dist/.vite/manifest.json lists the content-hashed build output. The backend
  // reads it to cache exactly those files forever; public/assets files keep
  // their names across releases and must not be.
  build: { manifest: true },
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
