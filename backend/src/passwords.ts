import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

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
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
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
