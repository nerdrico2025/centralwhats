import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

// ---------------------------------------------------------------- convites
/**
 * Token de convite: 32 bytes aleatórios. O BANCO guarda só o SHA-256 — o valor
 * em claro existe apenas no link. Vazamento da tabela `invites` não permite
 * aceitar convite nenhum.
 *
 * SHA-256 sem sal (e não scrypt) de propósito: o token já tem 256 bits de
 * entropia, então não há o que um ataque de dicionário faça. Sal aqui só
 * impediria a busca por hash, que é justamente como o aceite encontra o convite.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

// ------------------------------------------------------ chaves de API [P6.3]
/**
 * Prefixo legível da chave de serviço. Existe para reconhecimento visual: um
 * segredo colado por engano num log/issue é identificável como chave DESTE
 * sistema sem que ninguém precise testá-la. Mesmo hábito de GitHub (`ghp_`) e
 * Stripe (`sk_live_`).
 */
export const API_KEY_PREFIX = 'cw_live_';

/** Mesmo raciocínio do hashInviteToken: SHA-256 sem sal sobre 256 bits. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Chave nova: prefixo + 32 bytes aleatórios. O valor em claro é devolvido UMA
 * vez, na criação; o banco fica só com o hash.
 */
export function newApiKey(): { key: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key) };
}

/** A string tem a cara de uma chave nossa? (roteia entre API key e JWT) */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

/**
 * Amostra segura para log: só o prefixo e os 4 últimos caracteres. Nunca
 * imprima a chave inteira — o log é justamente onde ela não pode estar.
 */
export function maskApiKey(key: string): string {
  return key.length > API_KEY_PREFIX.length + 4
    ? `${API_KEY_PREFIX}…${key.slice(-4)}`
    : '(malformada)';
}

// --------------------------------------------------------------------- JWT
export interface TokenPayload {
  sub: string; // user id
  /**
   * Org ATIVA desta sessão — a que o usuário escolheu, não a única que ele
   * tem. Sozinho NÃO autoriza nada: o middleware confere o vínculo em
   * org_members a cada request (o token diz "quero esta org", o banco diz se
   * pode).
   */
  org_id: string;
  /** Papel no momento da emissão — informativo. O efetivo vem de org_members. */
  role: 'owner' | 'agent';
  /**
   * `users.password_changed_at` no momento da emissão (null se a senha nunca
   * mudou). O middleware compara com o valor ATUAL: diferente = token emitido
   * antes da troca = sessão revogada.
   *
   * Comparação de IGUALDADE, e não "iat < troca", de propósito: `iat` tem
   * granularidade de 1 segundo, então token antigo e token novo emitidos no
   * mesmo segundo seriam indistinguíveis — a revogação falharia justamente no
   * caso mais comum (trocar a senha porque ela vazou, agora).
   */
  pwd: string | null;
  iat: number; // epoch seconds — informativo
  exp: number; // epoch seconds
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

export function signToken(
  payload: Omit<TokenPayload, 'exp' | 'iat'>,
  secret: string,
  expiresInS = 60 * 60 * 24 * 7, // 7 dias
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat, exp: iat + expiresInS }));
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
