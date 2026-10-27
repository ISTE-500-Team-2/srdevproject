import { randomBytes, webcrypto } from 'node:crypto';
import { beforeEach, vi } from 'vitest';
import { configure } from '@testing-library/react';
import { JwtTokens } from '../../../backend/src/jwt';

// These assertions wait on real HTTP/PostgreSQL operations, including parallel CI runs.
configure({ asyncUtilTimeout: 20000 });

// jsdom has no matchMedia; the animation libraries ask for reduced motion.
if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

// jsdom has no ResizeObserver; the mobile nav and slider measure themselves.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom has no Web Animations API; the mobile nav plays a short intro with it.
if (!Element.prototype.animate)
  Element.prototype.animate = function () {
    return { cancel() {}, finish() {}, finished: Promise.resolve(), onfinish: null } as unknown as Animation;
  };

// The Express bridge runs in this same process. jsdom's Crypto omits subtle;
// use Node's real Web Crypto for JWT signing/verification, never a crypto mock.
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  await new JwtTokens(new Uint8Array(randomBytes(32))).issue(1, false);
});
