import type { Repo } from '../repo';
import type { Flow, FlowExecution, Instance } from '../repo/types';
import { sendViaProvider, type MessagingDeps } from './messaging';
import {
  runExecution,
  type EngineEffects,
  type EngineResult,
  type FlowAction,
  type FlowDefinition,
  type FlowEvent,
} from './flowEngine';

/** Timeout de limpeza de execuções presas, em horas (lição nº 5). */
const STUCK_TIMEOUT_H = Number(process.env.FLOW_STUCK_TIMEOUT_H ?? 48);

/**
 * Efeitos reais para o engine: contador atômico via repo, HTTP via fetch,
 * consulta de tag via repo. Injetáveis/substituíveis em teste.
 */
function makeEffects(repo: Repo, instance: Instance): EngineEffects {
  return {
    incrementAndGet: (flowId, nodeId, n) =>
      repo.flowNodeCounters.incrementAndGet(flowId, nodeId, n),
    random: () => Math.random(),
    async httpCall(req) {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.body != null ? { 'Content-Type': 'application/json' } : undefined,
        body: req.body != null ? JSON.stringify(req.body) : undefined,
      });
      return { status: resp.status, body: await resp.text() };
    },
    async hasTag(contactPhone, tagName) {
      const contact = await repo.contacts.getByPhone(instance.id, contactPhone);
      if (!contact) return false;
      const tags = await repo.tags.listForContact(instance.id, contact.id);
      return tags.some((t) => t.name === tagName);
    },
  };
}

/**
 * DRIVER do motor de fluxos (parte impura). O engine (flowEngine.ts) decide;
 * aqui a gente executa: manda mensagem via provider.*, persiste o novo estado
 * com trava otimista e retoma execuções vencidas. Sem dependência de HTTP —
 * chamável pela camada web e, na V2, pelo worker Baileys.
 */

function flowDefinition(flow: Flow): FlowDefinition {
  return {
    nodes: (flow.nodes as FlowDefinition['nodes']) ?? [],
    edges: (flow.edges as FlowDefinition['edges']) ?? [],
  };
}

/** Aplica uma tag (por nome) ao contato; cria a tag se não existir. */
async function applyTagByName(
  repo: Repo,
  instance: Instance,
  contactPhone: string,
  tagName: string,
): Promise<void> {
  if (!tagName) return;
  const contact = await repo.contacts.getByPhone(instance.id, contactPhone);
  if (!contact) return;
  const existing = (await repo.tags.list(instance.id)).find((t) => t.name === tagName);
  const tag =
    existing ?? (await repo.tags.create({ instance_id: instance.id, name: tagName, color: null }));
  await repo.tags.applyToContacts(instance.id, tag.id, [contact.id]);
}

/** Executa as ações retornadas pelo engine. Falha de envio não derruba o resto. */
async function performActions(
  repo: Repo,
  instance: Instance,
  actions: FlowAction[],
  deps: MessagingDeps,
): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.kind) {
        case 'sleep':
          // Delay CURTO (lição nº 2): dormir inline é aceitável abaixo do
          // limiar — risco de concorrência desprezível, e o bot mantém o ritmo.
          await new Promise((r) => setTimeout(r, action.ms));
          break;
        case 'send_text':
          await sendViaProvider(
            repo,
            instance,
            { type: 'text', to: action.to, text: action.text },
            deps,
          );
          break;
        case 'send_media':
          await sendViaProvider(
            repo,
            instance,
            { type: 'media', to: action.to, media: action.media },
            deps,
          );
          break;
        case 'send_buttons':
          await sendViaProvider(
            repo,
            instance,
            { type: 'buttons', to: action.to, body: action.body, buttons: action.buttons },
            deps,
          );
          break;
        case 'send_list':
          await sendViaProvider(
            repo,
            instance,
            {
              type: 'list',
              to: action.to,
              body: action.body,
              buttonText: action.buttonText,
              sections: action.sections,
            },
            deps,
          );
          break;
        case 'apply_tag':
          await applyTagByName(repo, instance, action.contactPhone, action.tagName);
          break;
        case 'warn':
          // LIÇÃO 4: aviso visível, nunca silêncio.
          // eslint-disable-next-line no-console
          console.warn('[flows] ' + action.message);
          break;
      }
    } catch (err) {
      // Envio já logado em messages (sucesso E falha) pelo serviço de
      // mensageria; aqui só evitamos derrubar a execução inteira.
      // eslint-disable-next-line no-console
      console.warn('[flows] falha ao executar ação do fluxo:', (err as Error).message);
    }
  }
}

async function applyEngineResult(
  repo: Repo,
  instance: Instance,
  execution: FlowExecution,
  result: EngineResult,
  deps: MessagingDeps,
): Promise<FlowExecution | null> {
  // Persiste o novo estado ANTES de executar ações demoradas — trava otimista
  // garante que só um processo aplica a transição.
  const updated = await repo.flowExecutions.updateIfStatus(execution.id, execution.status, {
    status: result.patch.status,
    current_node_id: result.patch.current_node_id,
    variables: result.patch.variables,
    next_step_at: result.patch.next_step_at,
  });
  if (!updated) return null; // outro processo avançou primeiro — não duplica ações
  await performActions(repo, instance, result.actions, deps);
  return updated;
}

/** Deps do motor de fluxos: provider (mensageria) + efeitos do engine. */
export interface FlowDeps extends MessagingDeps {
  effects?: EngineEffects;
}

/** Cria e roda uma execução do zero (Início → ...). */
export async function startFlowExecution(
  repo: Repo,
  instance: Instance,
  flow: Flow,
  contactPhone: string,
  deps: FlowDeps = {},
): Promise<FlowExecution | null> {
  const contact = await repo.contacts.getByPhone(instance.id, contactPhone);
  const execution = await repo.flowExecutions.create({
    flow_id: flow.id,
    instance_id: instance.id,
    contact_phone: contactPhone,
    current_node_id: null,
    status: 'running',
    variables: {},
    next_step_at: null,
  });

  const result = await runExecution(
    flowDefinition(flow),
    execution,
    { type: 'start' },
    {
      contactPhone: execution.contact_phone,
      contactName: contact?.name ?? null,
      flowId: flow.id,
      effects: deps.effects ?? makeEffects(repo, instance),
    },
  );
  return applyEngineResult(repo, instance, execution, result, deps);
}

/** Retoma uma execução já reivindicada (claim feito pelo chamador). */
async function resumeExecution(
  repo: Repo,
  instance: Instance,
  execution: FlowExecution,
  deps: FlowDeps,
): Promise<void> {
  const flow = await repo.flows.getById(instance.id, execution.flow_id);
  if (!flow) {
    // Fluxo apagado: mesmo espírito da lição 4 — loga, não some em silêncio.
    // eslint-disable-next-line no-console
    console.warn(`[flows] fluxo ${execution.flow_id} não existe mais; cancelando execução ${execution.id} COM aviso.`);
    await repo.flowExecutions.updateIfStatus(execution.id, execution.status, {
      status: 'cancelled',
    });
    return;
  }
  const contact = await repo.contacts.getByPhone(instance.id, execution.contact_phone);
  const event: FlowEvent = { type: 'resume' };
  const result = await runExecution(flowDefinition(flow), execution, event, {
    contactPhone: execution.contact_phone,
    contactName: contact?.name ?? null,
    flowId: flow.id,
    effects: deps.effects ?? makeEffects(repo, instance),
  });
  await applyEngineResult(repo, instance, execution, result, deps);
}

/**
 * Varredura de retomada (LIÇÃO 1): pega execuções com next_step_at vencido e
 * as retoma. Idempotente e segura sob concorrência — cada execução só é
 * retomada por quem vencer o claimDue (uma única instrução SQL condicional).
 * Disparada pelo tráfego de webhook, em background, por instância.
 */
export async function processPendingExecutions(
  repo: Repo,
  instanceId: string,
  deps: FlowDeps = {},
): Promise<{ resumed: number; cleaned: number }> {
  const instance = await repo.instances.getById(instanceId);
  if (!instance) return { resumed: 0, cleaned: 0 };

  const nowIso = new Date().toISOString();
  const due = await repo.flowExecutions.listDue(instanceId, nowIso);
  let resumed = 0;
  for (const execution of due) {
    const claimed = await repo.flowExecutions.claimDue(execution.id, nowIso);
    if (!claimed) continue; // outro processo chegou antes — sem duplicidade
    await resumeExecution(repo, instance, claimed, deps);
    resumed++;
  }

  // Limpeza de execuções presas (lição nº 5): cancela ativas paradas há mais
  // de STUCK_TIMEOUT_H horas, sem retomada futura agendada — e LOGA.
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_H * 3600 * 1000).toISOString();
  const cleaned = await repo.flowExecutions.cancelStuck(instanceId, cutoff);
  if (cleaned > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[flows] limpeza: ${cleaned} execução(ões) presa(s) há mais de ${STUCK_TIMEOUT_H}h cancelada(s) na instância ${instanceId}.`,
    );
  }
  return { resumed, cleaned };
}

/** Entrada do contato extraída do inbound (texto e/ou id de botão/opção). */
export interface FlowInput {
  text: string | null;
  replyId: string | null;
}

/**
 * Roteia um inbound para o motor de fluxos (chamado pelo webhook, P4.2):
 *  1. Se o contato tem execução em waiting_input → casa a resposta com a
 *     aresta do botão/opção e segue por ela.
 *  2. Senão, se o texto casa com trigger_keywords de um fluxo ativo → inicia,
 *     travando por (FLUXO + CONTATO) — lição 5: uma execução presa em outro
 *     fluxo NÃO bloqueia este.
 */
export async function handleFlowInbound(
  repo: Repo,
  instance: Instance,
  contactPhone: string,
  input: FlowInput,
  deps: FlowDeps = {},
): Promise<{ routed: boolean; started: boolean }> {
  // 1) Resposta a nó interativo?
  const waiting = await repo.flowExecutions.findWaitingByContact(instance.id, contactPhone);
  if (waiting) {
    const flow = await repo.flows.getById(instance.id, waiting.flow_id);
    if (!flow) {
      // eslint-disable-next-line no-console
      console.warn(`[flows] fluxo ${waiting.flow_id} sumiu; cancelando execução ${waiting.id} COM aviso.`);
      await repo.flowExecutions.updateIfStatus(waiting.id, 'waiting_input', {
        status: 'cancelled',
      });
      return { routed: false, started: false };
    }
    const contact = await repo.contacts.getByPhone(instance.id, contactPhone);
    const result = await runExecution(
      flowDefinition(flow),
      waiting,
      { type: 'input', input: { id: input.replyId, text: input.text } },
      {
        contactPhone: waiting.contact_phone,
        contactName: contact?.name ?? null,
        flowId: flow.id,
        lastText: input.text,
        effects: deps.effects ?? makeEffects(repo, instance),
      },
    );
    await applyEngineResult(repo, instance, waiting, result, deps);
    return { routed: true, started: false };
  }

  // 2) Gatilho por palavra-chave.
  const keyword = input.text?.trim();
  if (!keyword) return { routed: false, started: false };
  const flows = await repo.flows.findByTriggerKeyword(instance.id, keyword);
  for (const flow of flows) {
    // LIÇÃO 5: trava por (fluxo + contato), NUNCA por contato+instância.
    const active = await repo.flowExecutions.findActiveByFlowAndContact(flow.id, contactPhone);
    if (active) continue; // já rodando NESTE fluxo — não duplica
    await startFlowExecution(repo, instance, flow, contactPhone, deps);
    return { routed: false, started: true };
  }
  return { routed: false, started: false };
}

/**
 * Varredura AUTÔNOMA de execuções vencidas em TODAS as instâncias (cron).
 *
 * Fecha a mesma lacuna que o cron de campanhas fechou: até aqui os fluxos só
 * retomavam por tráfego de webhook (ou pelo worker do Baileys). Numa instância
 * sem inbound, um "Aguardar" longo ficava parado indefinidamente — a lição nº 1
 * do PRD reaparecendo em nível de infraestrutura, não de código.
 *
 * Reaproveita processPendingExecutions por instância: mesmo claim atômico
 * (claimDue), mesma limpeza de execuções presas, mesmos efeitos. Nada aqui
 * duplica o motor.
 *
 * Nunca lança: falha de uma instância vira log e a varredura segue.
 */
export async function processAllPendingFlows(
  repo: Repo,
  deps: FlowDeps = {},
  opts: { budgetMs?: number } = {},
): Promise<{ instances: number; resumed: number; cleaned: number; budgetExhausted: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? 8000);
  const out = { instances: 0, resumed: 0, cleaned: 0, budgetExhausted: false };

  let instances: Instance[];
  try {
    instances = await repo.instances.listAll();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cron/flows] falha ao listar instâncias:', err);
    return out;
  }
  out.instances = instances.length;

  for (const instance of instances) {
    if (Date.now() >= deadline) {
      out.budgetExhausted = true;
      break;
    }
    try {
      const r = await processPendingExecutions(repo, instance.id, deps);
      out.resumed += r.resumed;
      out.cleaned += r.cleaned;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[cron/flows] instância ${instance.id}: falha na varredura:`, err);
    }
  }
  return out;
}
