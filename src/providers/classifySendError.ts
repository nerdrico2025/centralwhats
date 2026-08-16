import type { ProviderType } from '../repo/types';
import { MetaApiError, TemplateParamsError } from './errors';

/**
 * CLASSIFICAÇÃO DE ERRO DE ENVIO, AGNÓSTICA DE PROVIDER (§3.5).
 *
 * POR QUÊ: a decisão "vale tentar de novo?" vivia como um Set de códigos
 * numéricos da Meta dentro do disparo em massa. Regra de negócio olhando
 * `130429` é regra que só funciona para um provider — e o Baileys, que nem
 * chega a produzir código, caía num `error_code: null` mudo.
 *
 * Aqui o mapeamento POR provider fica fechado neste arquivo; o consumidor
 * (disparo em massa, worker) lê só `kind`/`retryable` e nunca pergunta com
 * quem está falando.
 *
 * REGRA DE OURO: na dúvida, `unknown` + `retryable: false`. Errar para o lado
 * de não retentar é barato; retentar um erro permanente queima cota e, no
 * Baileys, aproxima o número de um bloqueio.
 */

export type SendErrorKind =
  | 'rate_limit'
  | 'invalid_recipient'
  | 'auth'
  | 'transient'
  | 'unknown';

export interface SendErrorClass {
  kind: SendErrorKind;
  /** ÚNICA fonte da decisão de retry. Ninguém mais olha código de provider. */
  retryable: boolean;
  /** Código original do provider (ou marcador nosso). Vai para o histórico. */
  raw_code: string | null;
  message: string;
}

/**
 * Rate-limit da Meta. Os dois códigos vieram do comportamento real da Graph
 * API e estavam em dispatch.ts antes desta camada existir.
 */
const META_RATE_LIMIT = new Set(['130429', '131056']);

/** Destinatário que não melhora com repetição (número inválido/indisponível). */
const META_INVALID_RECIPIENT = new Set(['131026']);

/** Erro do CHAMADOR, detectado antes da Graph API (ver TemplateParamsError). */
const TEMPLATE_PARAMS_CODE = 'TEMPLATE_PARAMS';

/**
 * Códigos de fechamento do Baileys (DisconnectReason, Types/index.js:13-25)
 * que aparecem como `output.statusCode` de um Boom lançado no envio.
 *
 * AUSÊNCIA DELIBERADA — RATE-LIMIT: o protocolo do WhatsApp Web não tem erro
 * de rate-limit por mensagem. Varredura em lib/Socket e lib/Utils não acha
 * `429` nem equivalente: excesso de envio se manifesta como QUEDA DE CONEXÃO
 * (428/515) ou, no pior caso, logout definitivo (401). Por isso NÃO existe
 * `kind: 'rate_limit'` para Baileys, e não se infere um a partir de padrão de
 * fechamento — seria adivinhação, e classificaria queda de rede como
 * rate-limit. Proteção contra volume, aqui, é espaçar o envio na origem
 * (throttle na outbox), não retentar depois. Pendência registrada, fora
 * do escopo desta camada.
 */
const BAILEYS_TRANSIENT = new Set([
  408, // connectionLost / timedOut  — Utils/generics.js:121
  428, // connectionClosed           — socket.js:55-58 (socket já fechado)
  503, // unavailableService
]);
const BAILEYS_AUTH = new Set([
  401, // loggedOut — sessão encerrada no celular
  403, // forbidden
]);

/** `output.statusCode` de um Boom, se houver. */
function statusCodeDe(error: unknown): number | null {
  const s = (error as { output?: { statusCode?: unknown } } | null)?.output?.statusCode;
  return typeof s === 'number' ? s : null;
}

function mensagemDe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'erro desconhecido');
}

/** Código já normalizado por quem embrulhou o erro (SendFailedError/MetaApiError). */
function codigoDe(error: unknown): string | null {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === 'string' && c ? c : null;
}

function classificarMeta(error: unknown): SendErrorClass {
  const message = mensagemDe(error);
  const code = codigoDe(error);
  const http = (error as { httpStatus?: unknown } | null)?.httpStatus;

  if (error instanceof TemplateParamsError || code === TEMPLATE_PARAMS_CODE) {
    // NOTA: o enum de `kind` não tem um caso para "requisição malformada pelo
    // chamador". `unknown` com retryable=false é o comportamento correto
    // (jamais retentar), e o raw_code preserva a identificação exata.
    return { kind: 'unknown', retryable: false, raw_code: TEMPLATE_PARAMS_CODE, message };
  }
  if (code && META_RATE_LIMIT.has(code)) {
    return { kind: 'rate_limit', retryable: true, raw_code: code, message };
  }
  if (code && META_INVALID_RECIPIENT.has(code)) {
    return { kind: 'invalid_recipient', retryable: false, raw_code: code, message };
  }
  if (http === 401 || http === 403) {
    return { kind: 'auth', retryable: false, raw_code: code, message };
  }
  // Demais códigos da Meta: identificados no histórico, mas NÃO retentados —
  // é exatamente o comportamento que existia antes desta camada.
  return { kind: 'unknown', retryable: false, raw_code: code, message };
}

function classificarBaileys(error: unknown): SendErrorClass {
  const message = mensagemDe(error);
  const status = statusCodeDe(error);
  const raw = status != null ? String(status) : codigoDe(error);

  if (status != null) {
    if (BAILEYS_TRANSIENT.has(status)) {
      return { kind: 'transient', retryable: true, raw_code: raw, message };
    }
    if (BAILEYS_AUTH.has(status)) {
      return { kind: 'auth', retryable: false, raw_code: raw, message };
    }
    // 500 = "All encryptions failed" (messages-send.js:424). Não retentamos:
    // não há evidência de que repetir resolva, e insistir num erro de sessão
    // Signal tende a piorar. Ver relatório — caso aberto para decisão manual.
    return { kind: 'unknown', retryable: false, raw_code: raw, message };
  }

  // Sessão não pareada: o Baileys estoura TypeError ao ler creds.me.id.
  if (error instanceof TypeError && /reading '?id'?/.test(message)) {
    return { kind: 'auth', retryable: false, raw_code: 'NOT_PAIRED', message };
  }
  // Erro NOSSO (baileysWorker.socketSender): a instância ainda não tem socket.
  // A varredura periódica reconecta, então repetir faz sentido.
  if (/sem socket conectado/i.test(message)) {
    return { kind: 'transient', retryable: true, raw_code: 'NO_SOCKET', message };
  }
  return { kind: 'unknown', retryable: false, raw_code: raw, message };
}

/**
 * Classifica um erro de envio. `provider` decide QUAL tabela de mapeamento
 * usar; o formato de saída é o mesmo para os dois.
 */
export function classifySendError(error: unknown, provider: ProviderType): SendErrorClass {
  // MetaApiError é da Graph API por definição, venha de onde vier.
  if (error instanceof MetaApiError) return classificarMeta(error);
  return provider === 'baileys' ? classificarBaileys(error) : classificarMeta(error);
}

/** Linha de log padrão — `unknown` NUNCA pode passar despercebido. */
export function descreverErroDeEnvio(c: SendErrorClass): string {
  return `kind=${c.kind} retryable=${c.retryable} code=${c.raw_code ?? '-'} msg=${c.message}`;
}
