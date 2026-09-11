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

export async function hashPassword(password: string): Promise<string> {
  if (bcrypt.truncates(password)) throw new AppError(400,'PASSWORD_TOO_LONG','Passwords must be at most 72 UTF-8 bytes.');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (/^\$2[aby]\$12\$/.test(encoded)) return !bcrypt.truncates(password) && bcrypt.compare(password, encoded);
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
