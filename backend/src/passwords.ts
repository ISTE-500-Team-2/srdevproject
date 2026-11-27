// New credentials use bcrypt; verified legacy scrypt hashes can be upgraded during sign-in without
// forcing password resets.

import bcrypt from 'bcryptjs';
import { AppError } from './domain.js';
import { scrypt, timingSafeEqual } from 'node:crypto';

const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

const PRODUCTION_COST = 12;

/**
 * bcrypt work factor. Real accounts always use 12. ARBOR_PASSWORD_COST may lower it
 * (to as little as 4) only outside production, so test suites don't spend ~225 ms per hash.
 */
export function passwordCost(): number {
  const raw = process.env.ARBOR_PASSWORD_COST;
  if (raw === undefined || raw === '') return PRODUCTION_COST;
  const cost = Number(raw);
  if (!/^\d{1,2}$/.test(raw) || cost < 4 || cost > PRODUCTION_COST)
    throw new Error('ARBOR_PASSWORD_COST must be an integer from 4 to 12');
  if (cost !== PRODUCTION_COST && process.env.NODE_ENV === 'production')
    throw new Error('ARBOR_PASSWORD_COST cannot be lowered in production');
  return cost;
}

/**
 * Reject inputs bcrypt would truncate before hashing; silent truncation would make distinct
 * passwords equivalent.
 */
export async function hashPassword(password: string): Promise<string> {
  if (bcrypt.truncates(password)) throw new AppError(400,'PASSWORD_TOO_LONG','Passwords must be at most 72 UTF-8 bytes.');
  return bcrypt.hash(password, passwordCost());
}

/**
 * Verify current bcrypt or strictly formatted legacy scrypt hashes; malformed stored encodings are
 * rejected.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  // Accept bcrypt hashes from the configured cost up to 12, so production stays
  // exactly-12 while a fast test run still accepts the cost-12 sample accounts.
  const bcryptCost = /^\$2[aby]\$(\d{2})\$/.exec(encoded)?.[1];
  if (bcryptCost !== undefined) {
    const cost = Number(bcryptCost);
    return cost >= passwordCost() && cost <= PRODUCTION_COST
      && !bcrypt.truncates(password) && bcrypt.compare(password, encoded);
  }
  const [algorithm, salt, hash, extra] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    !salt ||
    !hash ||
    extra ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{128}$/.test(hash)
  )
    return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(hash, 'hex'),
  );
}

export const needsPasswordUpgrade = (encoded: string) => encoded.startsWith("scrypt$");
