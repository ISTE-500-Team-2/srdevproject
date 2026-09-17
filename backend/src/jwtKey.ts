import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readJwtKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const production = env.NODE_ENV === 'production';
  const providedFile = env.JWT_SECRET_FILE;
  if (production && !providedFile)
    throw new Error('JWT_SECRET_FILE is required in production.');
  const keyFile = providedFile ?? env.JWT_DEV_KEY_FILE ?? path.resolve('.local/jwt-signing.key');

  if (!providedFile && !production) {
    // A private development key survives hot reload and application restarts.
    // Publish the completed file atomically; concurrent starters use one key.
    mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const temporary = keyFile + '.' + randomUUID();
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try {
      try {
        linkSync(temporary, keyFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      unlinkSync(temporary);
    }
  }

  const key = readFileSync(keyFile);
  if (key.byteLength < 32)
    throw new Error('The JWT signing key file must contain at least 32 random bytes.');
  return key;
}
