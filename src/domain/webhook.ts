import type { Repo } from '../repo';
import type { Instance, MessageStatus } from '../repo/types';
import { normalizePhone } from '../util/phone';
import { resolveInstanceByPhoneNumberId } from './instances';
import { processPendingExecutions, type FlowInput } from './flows';
import { recordInbound } from './inbound';
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

export interface WebhookResult {
  processedInbound: number;
  dedupedInbound: number;
  processedStatuses: number;
  skippedNoInstance: number;
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
  };
  const body = (payload as AnyObj) ?? {};
  const instancesWithInbound = new Set<string>();

  for (const entry of (body.entry as AnyObj[]) ?? []) {
    for (const change of (entry.changes as AnyObj[]) ?? []) {
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
    }
  }

  // §5: ao fim de QUALQUER inbound, dispara a varredura de retomada de fluxos
  // (por instância) — motor real desde P4.1.
  for (const instanceId of instancesWithInbound) {
    await processPendingExecutions(repo, instanceId, deps);
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
  if (mode !== 'subscribe' || !verifyToken) return false;
  const instances = await repo.instances.list();
  return instances.some((i) => i.verify_token != null && i.verify_token === verifyToken);
}
