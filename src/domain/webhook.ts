import type { Repo } from '../repo';
import type { Instance, MessageStatus } from '../repo/types';
import { normalizePhone } from '../util/phone';
import { resolveInstanceByPhoneNumberId } from './instances';
import { processPendingExecutions, type FlowInput } from './flows';
import { recordInbound } from './inbound';
import { processPendingCampaigns } from './dispatch';
import type { MessagingDeps } from './messaging';

/**
 * Processamento do payload do webhook da Meta Cloud API.
 *
 * REGRAS (CLAUDE.md):
 *  - A instância é identificada pelo phone_number_id DO PAYLOAD (metadata),
 *    nunca pela URL.
 *  - Inbound é deduplicado por wa_message_id (idempotência).
 *  - Status 'failed' grava errors[].code / errors[].message. Nada é descartado.
 *  - profile.name pode não vir (privacidade) → plano B: contato fica sem nome
 *    (fluxo pode pedir depois); nunca quebra o processamento.
 *  - Telefone sempre normalizado (o repo normaliza; aqui também para comparar).
 *  - Ao fim de QUALQUER inbound, dispara processPendingExecutions() da instância
 *    (varredura de retomada de fluxos, em background).
 *
 * Módulo puro de /domain: recebe o repo por parâmetro, sem HTTP.
 */

type AnyObj = Record<string, unknown>;

/** Mensagem legível de um erro desconhecido (para os logs da Vercel). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface WebhookResult {
  processedInbound: number;
  dedupedInbound: number;
  processedStatuses: number;
  skippedNoInstance: number;
  /** Changes que lançaram erro e foram puladas (cada uma logada individualmente). */
  failedChanges: number;
}

/** Mapeia o status textual da Meta para o enum interno. */
function mapStatus(s: string): MessageStatus {
  switch (s) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'sent';
  }
}

/** Extrai conteúdo estruturado + tipo interno de uma mensagem inbound da Meta. */
function parseInboundContent(msg: AnyObj): { type: string; content: unknown } {
  const type = String(msg.type ?? 'unknown');
  switch (type) {
    case 'text':
      return { type, content: { body: (msg.text as AnyObj)?.text ?? (msg.text as AnyObj)?.body } };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const media = (msg[type] as AnyObj) ?? {};
      return {
        type,
        content: {
          media_id: media.id ?? null,
          mime_type: media.mime_type ?? null,
          sha256: media.sha256 ?? null,
          caption: media.caption ?? null,
          filename: media.filename ?? null,
        },
      };
    }
    case 'button': {
      // Resposta de quick-reply de template.
      const b = (msg.button as AnyObj) ?? {};
      return { type, content: { text: b.text ?? null, payload: b.payload ?? null } };
    }
    case 'interactive': {
      const it = (msg.interactive as AnyObj) ?? {};
      const kind = String(it.type ?? '');
      const reply = (it[kind] as AnyObj) ?? {};
      return {
        type,
        content: {
          kind, // 'button_reply' | 'list_reply'
          id: reply.id ?? null,
          title: reply.title ?? null,
          description: reply.description ?? null,
        },
      };
    }
    case 'location': {
      const loc = (msg.location as AnyObj) ?? {};
      return {
        type,
        content: {
          latitude: loc.latitude ?? null,
          longitude: loc.longitude ?? null,
          name: loc.name ?? null,
          address: loc.address ?? null,
        },
      };
    }
    default:
      return { type, content: { raw: msg } };
  }
}

/** Extrai a entrada do contato (texto/botão) para o roteamento de fluxos. */
function extractFlowInput(type: string, content: unknown): FlowInput {
  const c = (content as AnyObj) ?? {};
  switch (type) {
    case 'text':
      return { text: (c.body as string) ?? null, replyId: null };
    case 'interactive': // button_reply / list_reply
      return { text: (c.title as string) ?? null, replyId: (c.id as string) ?? null };
    case 'button': // quick-reply de template
      return { text: (c.text as string) ?? null, replyId: (c.payload as string) ?? null };
    default:
      return { text: null, replyId: null };
  }
}

/** Processa um `change.value` já com a instância resolvida. */
async function processChangeValue(
  repo: Repo,
  instance: Instance,
  value: AnyObj,
  deps: MessagingDeps,
): Promise<{ inbound: number; deduped: number; statuses: number; hadInbound: boolean }> {
  const metadata = (value.metadata as AnyObj) ?? {};
  // Número da empresa (to_number do inbound). display_phone_number é a fonte
  // real; phone_number_id é só um ID (não-telefone). Sanitiza para dígitos e,
  // se não der um telefone válido, usa fallback — a mensagem NUNCA é perdida
  // por causa disso (o que importa é o contato + conteúdo).
  const rawBiz = String(
    metadata.display_phone_number ?? metadata.phone_number_id ?? instance.phone_number_id ?? '',
  );
  const bizDigits = rawBiz.replace(/\D+/g, '');
  const businessNumber = bizDigits.length >= 8 ? bizDigits : '000000000';

  // Mapa wa_id → profile.name (pode não vir; plano B trata ausência).
  const nameByWaId = new Map<string, string>();
  for (const c of (value.contacts as AnyObj[]) ?? []) {
    const waId = c.wa_id != null ? normalizePhone(String(c.wa_id)) : null;
    const name = ((c.profile as AnyObj)?.name as string) ?? null;
    if (waId && name) nameByWaId.set(waId, name);
  }

  let inbound = 0;
  let deduped = 0;
  let hadInbound = false;

  // --- Mensagens recebidas (núcleo compartilhado com o worker Baileys) ---
  for (const msg of (value.messages as AnyObj[]) ?? []) {
    hadInbound = true;
    const from = normalizePhone(String(msg.from));
    const { type, content } = parseInboundContent(msg);
    const result = await recordInbound(
      repo,
      instance,
      {
        waMessageId: msg.id != null ? String(msg.id) : null,
        from,
        toNumber: businessNumber || from,
        type,
        content,
        profileName: nameByWaId.get(from) ?? null,
        flowInput: extractFlowInput(type, content),
      },
      deps,
    );
    if (result === 'deduped') deduped++;
    else inbound++;
  }

  // --- Atualizações de status ---
  let statuses = 0;
  for (const st of (value.statuses as AnyObj[]) ?? []) {
    const waMessageId = st.id != null ? String(st.id) : null;
    if (!waMessageId) continue;
    const status = mapStatus(String(st.status));

    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (status === 'failed') {
      // NÃO descarta o erro: grava code + (title/message) do errors[].
      const err = ((st.errors as AnyObj[]) ?? [])[0] ?? {};
      errorCode = err.code != null ? String(err.code) : null;
      errorMessage =
        (err.message as string) ??
        (err.title as string) ??
        ((err.error_data as AnyObj)?.details as string) ??
        null;
    }

    await repo.messages.updateStatusByWaMessageId(instance.id, waMessageId, {
      status,
      error_code: errorCode,
      error_message: errorMessage,
    });
    statuses++;
  }

  return { inbound, deduped, statuses, hadInbound };
}

/**
 * Ponto de entrada: processa o payload inteiro (várias entries/changes).
 * Chamado em BACKGROUND pelo handler POST /webhook (a resposta HTTP já foi
 * enviada antes). Idempotente.
 */
export async function processInboundPayload(
  repo: Repo,
  payload: unknown,
  deps: MessagingDeps = {},
): Promise<WebhookResult> {
  const result: WebhookResult = {
    processedInbound: 0,
    dedupedInbound: 0,
    processedStatuses: 0,
    skippedNoInstance: 0,
    failedChanges: 0,
  };
  const body = (payload as AnyObj) ?? {};
  const instancesWithInbound = new Set<string>();

  const entries = (body.entry as AnyObj[]) ?? [];
  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei];
    const changes = (entry.changes as AnyObj[]) ?? [];
    for (let ci = 0; ci < changes.length; ci++) {
      const change = changes[ci];
      // Cada change é isolada: uma falha (banco fora, payload torto, erro de
      // provider) NUNCA aborta as demais changes do mesmo payload. Mesma lógica
      // do disparo em massa (CLAUDE.md): logue TODA falha, nunca descarte em
      // silêncio. A Meta reenvia o payload e o dedupe por wa_message_id garante
      // que as changes que já passaram não sejam reprocessadas.
      try {
        const value = (change.value as AnyObj) ?? {};
        const metadata = (value.metadata as AnyObj) ?? {};
        const phoneNumberId = metadata.phone_number_id
          ? String(metadata.phone_number_id)
          : '';

        const instance = await resolveInstanceByPhoneNumberId(repo, phoneNumberId);
        if (!instance) {
          // Instância desconhecida — não descarta em silêncio total: contabiliza.
          // eslint-disable-next-line no-console
          console.warn(`[webhook] phone_number_id sem instância: ${phoneNumberId}`);
          result.skippedNoInstance++;
          continue;
        }

        const r = await processChangeValue(repo, instance, value, deps);
        result.processedInbound += r.inbound;
        result.dedupedInbound += r.deduped;
        result.processedStatuses += r.statuses;
        if (r.hadInbound) instancesWithInbound.add(instance.id);
      } catch (err) {
        result.failedChanges++;
        // eslint-disable-next-line no-console
        console.error(
          `[webhook] Falha ao processar change (entry ${ei}, change ${ci}): ${errMessage(err)}`,
          err,
        );
      }
    }
  }

  // §5: ao fim de QUALQUER inbound, dispara a varredura de retomada de fluxos
  // (por instância) — motor real desde P4.1. Também isolada por instância: uma
  // varredura que falha não pode impedir a das outras instâncias do payload.
  for (const instanceId of instancesWithInbound) {
    try {
      await processPendingExecutions(repo, instanceId, deps);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] Falha na varredura de retomada de fluxos da instância ${instanceId}: ${errMessage(err)}`,
        err,
      );
    }
    // Campanhas usam a MESMA retomada por tráfego dos fluxos: sem isso o
    // disparo só andava enquanto a UI estivesse aberta em polling.
    try {
      const inst = await repo.instances.getById(instanceId);
      if (inst) await processPendingCampaigns(repo, inst, deps);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] Falha na retomada de campanhas da instância ${instanceId}: ${errMessage(err)}`,
        err,
      );
    }
  }

  return result;
}

/**
 * Verificação do desafio (GET /webhook). Como a URL é única, a instância é
 * identificada casando hub.verify_token com o verify_token de alguma instância.
 * Retorna true se o desafio é válido (mode=subscribe + token conhecido).
 */
export async function isValidVerifyChallenge(
  repo: Repo,
  mode: string | undefined,
  verifyToken: string | undefined,
): Promise<boolean> {
  return (await verifyChallenge(repo, mode, verifyToken)).ok;
}

/** Motivo específico da recusa — vira log legível no handler HTTP. */
export type VerifyFailureReason =
  | 'mode_invalido'
  | 'token_ausente'
  | 'nenhuma_instancia'
  | 'nenhuma_instancia_com_verify_token'
  | 'token_nao_confere';

export interface VerifyChallengeResult {
  ok: boolean;
  reason?: VerifyFailureReason;
  /** Diagnóstico para o log (nunca exposto na resposta HTTP). */
  diag?: {
    mode?: string;
    totalInstances?: number;
    withVerifyToken?: number;
    receivedLength?: number;
    /** Bateria se ambos os lados fossem trimados → há espaço/quebra de linha. */
    matchesAfterTrim?: boolean;
    /** Bateria ignorando maiúsc/minúsc → diferença só de case. */
    matchesIgnoringCase?: boolean;
  };
}

/**
 * Mesma decisão de `isValidVerifyChallenge`, mas devolvendo o MOTIVO da recusa.
 *
 * A decisão de segurança NÃO muda: só há `ok: true` na comparação exata
 * (case-sensitive, sem trim) contra o verify_token salvo. Os campos
 * `matchesAfterTrim` / `matchesIgnoringCase` existem apenas para o log dizer
 * *por que* não bateu — jamais para aceitar o token.
 */
export async function verifyChallenge(
  repo: Repo,
  mode: string | undefined,
  verifyToken: string | undefined,
): Promise<VerifyChallengeResult> {
  if (mode !== 'subscribe') {
    return { ok: false, reason: 'mode_invalido', diag: { mode: mode ?? '(ausente)' } };
  }
  if (!verifyToken) return { ok: false, reason: 'token_ausente' };

  const instances = await repo.instances.list();
  if (instances.length === 0) {
    return { ok: false, reason: 'nenhuma_instancia', diag: { totalInstances: 0 } };
  }

  const withToken = instances.filter((i) => i.verify_token != null && i.verify_token !== '');
  const diag = {
    totalInstances: instances.length,
    withVerifyToken: withToken.length,
    receivedLength: verifyToken.length,
  };
  if (withToken.length === 0) {
    return { ok: false, reason: 'nenhuma_instancia_com_verify_token', diag };
  }

  // Comparação EXATA — a única que autoriza.
  if (withToken.some((i) => i.verify_token === verifyToken)) return { ok: true };

  // Não bateu: descobre a causa provável para o log (sem afrouxar nada).
  const received = verifyToken.trim();
  return {
    ok: false,
    reason: 'token_nao_confere',
    diag: {
      ...diag,
      matchesAfterTrim: withToken.some((i) => (i.verify_token ?? '').trim() === received),
      matchesIgnoringCase: withToken.some(
        (i) => (i.verify_token ?? '').toLowerCase() === verifyToken.toLowerCase(),
      ),
    },
  };
}
