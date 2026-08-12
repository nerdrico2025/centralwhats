import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { loadEnv } from '../config';

/**
 * Criptografia de segredos EM REPOUSO (P6.1 / L1).
 *
 * Usada SÓ na fronteira dos adapters de `repo.*` — nenhuma rota, nenhum
 * domínio e nenhum worker sabe que ela existe. Campos cobertos:
 *   - instances.token, instances.verify_token  (credenciais da Meta)
 *   - baileys_auth.value                       (sessão do WhatsApp)
 *
 * A sessão do Baileys é o item mais sensível do banco: quem a possui ESTÁ
 * logado no WhatsApp da pessoa (envia em nome dela, lê o histórico). O token
 * da Meta ao menos é revogável pelo painel; a sessão não é.
 *
 * FORMATO: `enc:v1:<iv>:<tag>:<ciphertext>`, tudo base64url.
 * AES-256-GCM (autenticado — adulteração é detectada, o que CBC não faz), IV
 * aleatório por valor.
 *
 * LEITURA TOLERANTE: valor SEM o prefixo é texto claro legado e é devolvido
 * como está. É o que permite subir o código antes de migrar os dados (o
 * backfill roda depois, sem janela de indisponibilidade).
 *
 * FALHA ALTA: valor COM prefixo que não decifra é ERRO, nunca null silencioso.
 * Devolver null aqui transformaria "chave errada no deploy" em "instância sem
 * token" — o webhook pararia e ninguém entenderia por quê.
 */

const PREFIX_V1 = 'enc:v1:';
const PREFIX_ANY = 'enc:';

/** Sal fixo da derivação: a chave do env vira 32 bytes determinísticos. */
const KDF_SALT = 'wa-manager/secrets/v1';

let cachedFrom: string | null = null;
let cachedKey: Buffer | null = null;

/** Erro de decifragem — sempre propaga (nunca vira null). */
export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/** Chave ativa, ou null se SECRETS_ENCRYPTION_KEY não estiver configurada. */
function activeKey(): Buffer | null {
  const secret = loadEnv().SECRETS_ENCRYPTION_KEY;
  if (!secret) {
    cachedFrom = null;
    cachedKey = null;
    return null;
  }
  if (cachedKey && cachedFrom === secret) return cachedKey;
  cachedKey = scryptSync(secret, KDF_SALT, 32);
  cachedFrom = secret;
  return cachedKey;
}

/** Já está no formato cifrado? (base da idempotência do backfill.) */
export function isEncrypted(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(PREFIX_ANY);
}

/**
 * Cifra para gravação. Idempotente: valor JÁ cifrado volta inalterado — rodar
 * o backfill duas vezes não gera cifra sobre cifra.
 *
 * Sem chave configurada (dev/test), grava em texto claro. Em produção a
 * ausência da chave já é barrada no boot (src/config/env.ts), então este
 * caminho não existe lá.
 */
export function sealSecret(value: string | null | undefined): string | null {
  if (value == null || value === '') return value ?? null;
  if (isEncrypted(value)) return value;
  const key = activeKey();
  if (!key) return value;

  const iv = randomBytes(12); // 96 bits — tamanho recomendado para GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX_V1 +
    [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':')
  );
}

/**
 * Decifra na leitura. Texto claro legado (sem prefixo) passa direto.
 * Qualquer falha com prefixo presente LANÇA — ver a nota de falha alta acima.
 */
export function openSecret(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return String(value);
  if (!value.startsWith(PREFIX_ANY)) return value; // legado em texto claro

  if (!value.startsWith(PREFIX_V1)) {
    throw new SecretDecryptError(
      `Segredo com versão de criptografia desconhecida (esperado "${PREFIX_V1}"). ` +
        'Este banco foi escrito por uma versão MAIS NOVA do código.',
    );
  }
  const key = activeKey();
  if (!key) {
    throw new SecretDecryptError(
      'Há segredo cifrado no banco mas SECRETS_ENCRYPTION_KEY não está definida. ' +
        'Defina a MESMA chave usada para gravar (Vercel e worker) — sem ela o dado é irrecuperável.',
    );
  }

  const parts = value.slice(PREFIX_V1.length).split(':');
  if (parts.length !== 3) {
    throw new SecretDecryptError('Segredo cifrado malformado (esperado iv:tag:ciphertext).');
  }
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    // Causa quase sempre: chave DIFERENTE da que gravou (ex.: worker e web com
    // SECRETS_ENCRYPTION_KEY distintas). Mensagem acionável, sem vazar o valor.
    throw new SecretDecryptError(
      'Falha ao decifrar segredo: a SECRETS_ENCRYPTION_KEY não confere com a que gravou o dado ' +
        `(ou o valor foi adulterado). Detalhe: ${(err as Error).message}`,
    );
  }
}

/** Limpa o cache da chave derivada — usado por testes que mexem no env. */
export function resetSecretKeyCache(): void {
  cachedFrom = null;
  cachedKey = null;
}
