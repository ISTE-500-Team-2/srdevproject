import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export const jwtIssuer = 'arbor-collaboratory';
export const jwtAudience = 'arbor-collaboratory-api';
export const sessionLifetimeSeconds = 15 * 60;
export const rememberedLifetimeSeconds = 30 * 24 * 60 * 60;

export class JwtTokens {
  constructor(private key: Uint8Array, private accessSeconds = sessionLifetimeSeconds) {
    if (key.byteLength < 32)
      throw new Error('The JWT signing key must contain at least 32 random bytes.');
  }

  async issue(userId: number, role: string, roles: string[]) {
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new Error('Invalid JWT subject');
    const now = Math.floor(Date.now() / 1000);
    const lifetime = this.accessSeconds;
    const expiresAt = now + lifetime;
    // Role claims are a snapshot; authorization still reads current DB roles.
    const token = await new SignJWT({role, roles})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(userId))
      .setJti(randomUUID())
      .setIssuer(jwtIssuer)
      .setAudience(jwtAudience)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000), ttl: lifetime * 1000 };
  }

  async verify(token: string): Promise<{ userId: number } | null> {
    if (!token || token.length > 2048) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        typ: 'JWT',
        issuer: jwtIssuer,
        audience: jwtAudience,
        requiredClaims: ['sub', 'jti', 'iat', 'nbf', 'exp', 'iss', 'aud', 'role', 'roles'],
        maxTokenAge: this.accessSeconds,
      });
      if (
        typeof payload.role !== 'string' || !payload.role || !Array.isArray(payload.roles) || !payload.roles.length || !payload.roles.includes(payload.role) || !payload.roles.every(r => typeof r === 'string') ||
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string' ||
        !/^[1-9]\d*$/.test(payload.sub!) ||
        !Number.isSafeInteger(Number(payload.sub)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.jti!) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.nbf) ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > this.accessSeconds
      ) return null;
      return { userId: Number(payload.sub) };
    } catch {
      // Do not expose tokens, claims, keys, or signature details in errors/logs.
      return null;
    }
  }
}
