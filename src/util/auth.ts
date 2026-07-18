import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Auth da V2 (P5.1): hash de senha (scrypt) e JWT HS256 próprios, via
 * node:crypto — zero dependência externa. Segredos nunca vão ao client.
 */

// ------------------------------------------------------------------- senhas
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// --------------------------------------------------------------------- JWT
export interface TokenPayload {
  sub: string; // user id
  org_id: string;
  role: 'owner' | 'agent';
  exp: number; // epoch seconds
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

export function signToken(
  payload: Omit<TokenPayload, 'exp'>,
  secret: string,
  expiresInS = 60 * 60 * 24 * 7, // 7 dias
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInS }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // expirado
    }
    return payload;
  } catch {
    return null;
  }
}
