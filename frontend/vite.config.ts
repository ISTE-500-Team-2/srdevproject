/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { compileDarkTwins } from './src/theme/darkCompiler.ts';

/** Adds the dark-mode twin of every app stylesheet rule that sets a color (see src/theme/darkCompiler.ts). */
function darkTheme(): Plugin {
  return {
    name: 'collaboratory-dark-theme',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!.replace(/\\/g, '/');
      if (!file.endsWith('.css') || !file.includes('/src/') || file.includes('/src/theme/')) return null;
      return { code: compileDarkTwins(code, file), map: null };
    },
  };
}

export default defineConfig({
  plugins: [darkTheme(), react()],
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
