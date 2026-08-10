import type { Repo } from '../repo';
import type { Campaign, CampaignSend, Instance, Template } from '../repo/types';
import { sendViaProvider, SendFailedError, type MessagingDeps } from './messaging';
import { resolveRecipients } from './campaigns';

/** Erro de disparo com mensagem para o client (mapeado a 400 na rota). */
export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

// Retry SÓ em rate-limit (CLAUDE.md). Erro permanente (número inválido) não
// melhora tentando de novo.
const RATE_LIMIT_CODES = new Set(['130429', '131056']);
const MAX_ATTEMPTS = 5;
const DEFAULT_BUDGET_MS = 8000;
/** Claim mais velho que isto = tick que morreu; a linha volta para a fila. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Orçamento menor na retomada por tráfego (divide a invocação com o inbound). */
const TRAFFIC_BUDGET_MS = 3000;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export interface TickResult {
  status: string;
  processed: number;
  sent: number;
  failed: number;
  pending: number;
}

export interface DispatchOpts {
  /** Sobrescreve o tamanho do lote (default: adaptado ao interval_ms). */
  batchSize?: number;
  /** Orçamento de tempo por tick (ms) para dimensionar o lote. */
  budgetMs?: number;
}

/**
 * Inicia (ou retoma) uma campanha: MATERIALIZA a fila em campaign_sends com
 * status 'pending' e as variáveis congeladas por destinatário, e marca a
 * campanha como 'running'. Idempotente: se a fila já existe, apenas retoma.
 */
export async function startCampaign(
  repo: Repo,
  instance: Instance,
  campaignId: string,
  _deps: MessagingDeps = {},
): Promise<Campaign> {
  const campaign = await repo.campaigns.getById(instance.id, campaignId);
  if (!campaign) throw new DispatchError('Campanha não encontrada');
  if (!campaign.template_id) {
    throw new DispatchError('Campanha sem template — defina um template para disparar.');
  }
  const tpl = await repo.templates.getById(instance.id, campaign.template_id);
  if (!tpl) throw new DispatchError('Template da campanha não encontrado (rode o sync).');

  // Materializa a fila só uma vez (congelando o público e as variáveis).
  const existing = await repo.campaigns.listSends(campaignId);
  if (existing.length === 0) {
    const { recipients } = await resolveRecipients(repo, instance, campaign.config);
    for (const r of recipients) {
      await repo.campaigns.recordSend({
        campaign_id: campaignId,
        contact_id: r.contact_id,
        contact_phone: r.phone,
        status: 'pending',
        wa_message_id: null,
        error_code: null,
        error_message: null,
        sent_at: null,
        claimed_at: null,
        vars: r.vars,
        attempts: 0,
      });
    }
  }

  const counts = await repo.campaigns.countSendsByStatus(campaignId);
  const total = counts.sent + counts.failed + counts.pending;
  return (await repo.campaigns.update(instance.id, campaignId, {
    status: 'running',
    total_recipients: total,
  }))!;
}

/** Processa UM destinatário e grava SEMPRE o resultado (sucesso E falha). */
async function processOne(
  repo: Repo,
  instance: Instance,
  campaign: Campaign,
  tpl: Template,
  send: CampaignSend,
  deps: MessagingDeps,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const attempts = send.attempts + 1;
  try {
    const { result } = await sendViaProvider(
      repo,
      instance,
      {
        type: 'template',
        to: send.contact_phone,
        // idioma vem do template sincronizado — fonte da verdade.
        template: { name: tpl.name, language: tpl.language },
        vars: send.vars,
      },
      deps,
      campaign.id,
    );
    await repo.campaigns.updateSend(send.id, {
      status: 'sent',
      sent_at: nowIso,
      wa_message_id: result.waMessageId,
      error_code: null,
      error_message: null,
      attempts,
    });
  } catch (err) {
    if (err instanceof SendFailedError) {
      // Retry SÓ em rate-limit (com espera até o próximo tick), até MAX_ATTEMPTS.
      if (RATE_LIMIT_CODES.has(err.code ?? '') && attempts < MAX_ATTEMPTS) {
        await repo.campaigns.updateSend(send.id, {
          status: 'pending', // continua na fila; espera natural até o próximo tick
          claimed_at: null, // libera o claim para o próximo tick pegar
          attempts,
          error_code: err.code,
          error_message: 'rate-limit; será retentado',
        });
      } else {
        await repo.campaigns.updateSend(send.id, {
          status: 'failed',
          sent_at: nowIso,
          attempts,
          error_code: err.code,
          error_message: err.message,
        });
      }
    } else {
      // Erro inesperado — NUNCA perde: registra como falha com o motivo.
      await repo.campaigns.updateSend(send.id, {
        status: 'failed',
        sent_at: nowIso,
        attempts,
        error_code: null,
        error_message: String((err as Error)?.message ?? err),
      });
    }
  }
}

/**
 * Processa UM lote da campanha e reagenda o próximo (retomável). NUNCA a
 * campanha inteira numa request (timeout serverless).
 *
 * Regras: Promise.allSettled (falha isolada não descarta os demais);
 * espaçamento por interval_ms (sem paralelismo agressivo — teto é por número);
 * tamanho do lote adaptado ao orçamento de tempo (batchSize*interval ≤ budget).
 */
export async function processCampaignTick(
  repo: Repo,
  instance: Instance,
  campaignId: string,
  deps: MessagingDeps = {},
  opts: DispatchOpts = {},
): Promise<TickResult> {
  const campaign = await repo.campaigns.getById(instance.id, campaignId);
  if (!campaign) throw new DispatchError('Campanha não encontrada');

  if (campaign.status !== 'running') {
    const counts = await repo.campaigns.countSendsByStatus(campaignId);
    return { status: campaign.status, processed: 0, ...counts };
  }

  const tpl = campaign.template_id
    ? await repo.templates.getById(instance.id, campaign.template_id)
    : null;
  if (!tpl) throw new DispatchError('Template da campanha não encontrado.');

  const interval = Math.max(0, campaign.interval_ms || 0);
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const batchSize =
    opts.batchSize ??
    (interval > 0 ? Math.max(1, Math.min(50, Math.floor(budget / interval))) : 50);

  // Tick que morreu no meio (timeout serverless) deixa linhas presas em
  // 'sending'. Devolve à fila antes de reivindicar o próximo lote.
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  await repo.campaigns.reclaimStaleSends(campaignId, staleBefore);

  // Claim ATÔMICO: pending → sending numa instrução só. Sem isso, o polling da
  // UI e a retomada por webhook poderiam pegar o mesmo destinatário e o contato
  // receberia a mensagem duas vezes.
  const batch = await repo.campaigns.claimPendingSends(
    campaignId,
    batchSize,
    new Date().toISOString(),
  );
  if (batch.length === 0) {
    const counts = await repo.campaigns.countSendsByStatus(campaignId);
    // Lote vazio NÃO significa campanha concluída: outro tick concorrente pode
    // estar segurando as linhas ('sending' conta como pendente). Marcar
    // 'completed' aqui deixaria destinatários pendentes para sempre, sem
    // ninguém para retomá-los — falha silenciosa, o pior caso possível.
    if (counts.pending > 0) {
      return { status: 'running', processed: 0, ...counts };
    }
    await repo.campaigns.update(instance.id, campaignId, {
      status: 'completed',
      sent_count: counts.sent,
      failed_count: counts.failed,
    });
    return { status: 'completed', processed: 0, ...counts };
  }

  // Espaçados por interval_ms; allSettled garante que nenhum resultado é perdido.
  await Promise.allSettled(
    batch.map((send, i) =>
      sleep(i * interval).then(() => processOne(repo, instance, campaign, tpl, send, deps)),
    ),
  );

  const counts = await repo.campaigns.countSendsByStatus(campaignId);
  const done = counts.pending === 0;
  await repo.campaigns.update(instance.id, campaignId, {
    status: done ? 'completed' : 'running',
    sent_count: counts.sent,
    failed_count: counts.failed,
  });
  return { status: done ? 'completed' : 'running', processed: batch.length, ...counts };
}

/**
 * Retoma as campanhas 'running' da instância — MESMO mecanismo dos fluxos:
 * disparado pelo tráfego de webhook, em background, depois do 200 (ver
 * domain/webhook.ts, que já chama processPendingExecutions no mesmo ponto).
 *
 * Sem isso a campanha só avançava enquanto a UI estivesse aberta fazendo
 * polling do /tick. Cada campanha processa UM lote com orçamento curto — nada
 * de segurar a invocação; o que sobra fica em campaign_sends para o próximo
 * tick (da UI ou do próximo webhook).
 *
 * Nunca lança: a retomada é oportunista e não pode derrubar o processamento do
 * inbound. Falha vira log, nunca silêncio.
 */
export async function processPendingCampaigns(
  repo: Repo,
  instance: Instance,
  deps: MessagingDeps = {},
): Promise<void> {
  let campaigns;
  try {
    campaigns = (await repo.campaigns.list(instance.id)).filter((c) => c.status === 'running');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[campanha] falha ao listar campanhas em execução:', err);
    return;
  }
  for (const c of campaigns) {
    try {
      await processCampaignTick(repo, instance, c.id, deps, { budgetMs: TRAFFIC_BUDGET_MS });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[campanha ${c.id}] falha ao retomar por tráfego:`, err);
    }
  }
}

/** Pausa uma campanha em andamento (os ticks param de processar). */
export async function pauseCampaign(
  repo: Repo,
  instance: Instance,
  campaignId: string,
): Promise<Campaign> {
  const campaign = await repo.campaigns.getById(instance.id, campaignId);
  if (!campaign) throw new DispatchError('Campanha não encontrada');
  return (await repo.campaigns.update(instance.id, campaignId, { status: 'paused' }))!;
}
