import type { Repo } from '../repo';
import type { Instance } from '../repo/types';
import { normalizePhone } from '../util/phone';
import { handleFlowInbound, type FlowDeps, type FlowInput } from './flows';

/**
 * Registro de mensagem RECEBIDA — núcleo COMPARTILHADO entre o webhook da
 * Meta (V1) e o worker Baileys (V2). Reuso total: mesma dedupe, mesmo
 * contato/CRM, mesma gravação em messages e o MESMO motor de fluxos.
 */

export interface NormalizedInbound {
  waMessageId: string | null;
  /** Telefone do contato (qualquer formatação — normalizamos aqui). */
  from: string;
  /** Número da empresa (to_number da mensagem). */
  toNumber: string;
  type: string;
  content: unknown;
  /** Nome do perfil, se o provedor compartilhou (plano B: null). */
  profileName: string | null;
  /** Entrada para o roteamento de fluxos (texto/botão). */
  flowInput: FlowInput;
}

export async function recordInbound(
  repo: Repo,
  instance: Instance,
  msg: NormalizedInbound,
  deps: FlowDeps = {},
): Promise<'saved' | 'deduped'> {
  // Dedupe por wa_message_id (idempotência).
  if (msg.waMessageId) {
    const existing = await repo.messages.getByWaMessageId(instance.id, msg.waMessageId);
    if (existing) return 'deduped';
  }

  const from = normalizePhone(msg.from);
  const nowIso = new Date().toISOString();

  // Contato: upsert (plano B — name pode ser null) + last_seen.
  const contact = await repo.contacts.upsert({
    instance_id: instance.id,
    phone: from,
    name: msg.profileName,
    last_seen: nowIso,
  });
  await repo.contacts.touchLastSeen(instance.id, from, nowIso);

  // CRM: cria/atualiza o lead, preservando o que já existe.
  const existingCrm = await repo.crm.getByContact(instance.id, contact.id);
  await repo.crm.upsert({
    instance_id: instance.id,
    contact_id: contact.id,
    phone: from,
    name: msg.profileName ?? existingCrm?.name ?? null,
    stage: existingCrm?.stage ?? 'lead',
    score: existingCrm?.score ?? 0,
    notes: existingCrm?.notes ?? null,
    custom_fields: existingCrm?.custom_fields ?? {},
  });

  await repo.messages.create({
    instance_id: instance.id,
    direction: 'in',
    from_number: from,
    to_number: msg.toNumber,
    type: msg.type,
    content: msg.content,
    status: 'delivered',
    error_code: null,
    error_message: null,
    wa_message_id: msg.waMessageId,
    campaign_id: null,
  });

  // Roteamento de fluxos: resposta a botão/lista OU gatilho por keyword.
  // Erro no fluxo não pode derrubar o processamento do inbound.
  try {
    await handleFlowInbound(repo, instance, from, msg.flowInput, deps);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[inbound] erro no roteamento de fluxo:', (err as Error).message);
  }

  return 'saved';
}
