import { randomBytes, webcrypto } from 'node:crypto';
import { beforeEach, vi } from 'vitest';
import { JwtTokens } from '../../../backend/src/jwt';

// The Express bridge runs in this same process. jsdom's Crypto omits subtle;
// use Node's real Web Crypto for JWT signing/verification, never a crypto mock.
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  await new JwtTokens(new Uint8Array(randomBytes(32))).issue(1, false);
});
