import type { FlowExecution, FlowExecutionStatus } from '../repo/types';

/**
 * MOTOR DE FLUXOS — núcleo PURO (P4.1).
 *
 * runExecution() avança a máquina de estados nó a nó e retorna:
 *   - as AÇÕES a executar (ex.: enviar mensagem via provider), e
 *   - o novo estado a persistir (patch).
 * É determinística e testável sem rede: quem fala com provider/repo é o
 * driver (flows.ts). Nada de HTTP aqui — chamável pela camada web e, na V2,
 * pelo worker Baileys.
 *
 * P4.1: nós Início, Mensagem e Fim. Os demais entram em P4.2–P4.4.
 */

export interface FlowNode {
  id: string;
  type: string; // 'start' | 'message' | 'end' | (futuros)
  data?: Record<string, unknown>;
}

export interface FlowEdge {
  source: string;
  target: string;
  /** Saída específica do nó (botões/condições — fases futuras). */
  sourceHandle?: string | null;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface EngineMedia {
  kind: 'image' | 'video' | 'audio' | 'document';
  url?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

export interface EngineButton {
  id: string;
  title: string;
}

export interface EngineListSection {
  title?: string;
  rows: { id: string; title: string; description?: string }[];
}

export type FlowAction =
  | { kind: 'send_text'; to: string; text: string }
  | { kind: 'sleep'; ms: number } // delay CURTO — o driver dorme inline
  | { kind: 'send_media'; to: string; media: EngineMedia }
  | { kind: 'send_buttons'; to: string; body: string; buttons: EngineButton[] }
  | {
      kind: 'send_list';
      to: string;
      body: string;
      buttonText: string;
      sections: EngineListSection[];
    }
  | { kind: 'apply_tag'; contactPhone: string; tagName: string }
  | { kind: 'warn'; message: string };

export interface EnginePatch {
  status: FlowExecutionStatus;
  current_node_id: string | null;
  variables: Record<string, unknown>;
  /** Quando retomar (delay longo). null limpa qualquer agendamento anterior. */
  next_step_at: string | null;
}

export interface EngineResult {
  actions: FlowAction[];
  patch: EnginePatch;
}

export type FlowEvent =
  | { type: 'start' } // primeira execução (posiciona no nó Início)
  | { type: 'resume' } // retomada (delay vencido etc.)
  | {
      type: 'input'; // resposta do contato a um nó interativo (botão/lista)
      input: { id: string | null; text: string | null };
    };

/**
 * Efeitos que alguns nós precisam (contador atômico, aleatoriedade, HTTP,
 * consulta de tag). INJETADOS pelo driver: o engine continua sem dependência
 * direta de repo/rede e 100% testável com fakes.
 */
export interface EngineEffects {
  /** Round-robin do Randomizador — UMA instrução SQL atômica (lição nº 3). */
  incrementAndGet(flowId: string, nodeId: string, n: number): Promise<number>;
  /** Fonte de aleatoriedade (injetável p/ teste determinístico). */
  random(): number;
  /** Chamada HTTP do nó Webhook. */
  httpCall(req: {
    url: string;
    method: 'GET' | 'POST';
    body?: unknown;
  }): Promise<{ status: number; body: string }>;
  /** O contato tem a tag? (nó Condição, regra has_tag). */
  hasTag(contactPhone: string, tagName: string): Promise<boolean>;
}

export interface EngineContext {
  contactPhone: string;
  contactName: string | null;
  /** "Agora" em ISO — injetado para o engine seguir determinístico. */
  now?: string;
  /** Id do fluxo (necessário p/ o contador do Randomizador). */
  flowId?: string;
  /** Último texto recebido do contato (nó Condição, regra text_contains). */
  lastText?: string | null;
  /** Efeitos injetados (obrigatórios p/ randomizer/condition/webhook). */
  effects?: EngineEffects;
}

/** Proteção contra ciclos no grafo — um passo por nó já é generoso. */
const MAX_STEPS = 100;

/**
 * LIMIAR DO DELAY HÍBRIDO (lição nº 2), em segundos.
 * - Abaixo do limiar: dormir inline é aceitável (risco de concorrência
 *   desprezível) e evita o bot parecer "preso" esperando o lead cutucar.
 * - No limiar ou acima: NUNCA dormir no processo (lição nº 1) — resolve-se a
 *   próxima aresta JÁ, grava-se next_step_at e retorna-se sem esperar;
 *   processPendingExecutions() retoma via tráfego de webhook.
 * Configurável por env FLOW_DELAY_INLINE_THRESHOLD_S (default 10).
 */
export const DELAY_INLINE_THRESHOLD_S = Number(
  process.env.FLOW_DELAY_INLINE_THRESHOLD_S ?? 10,
);

/**
 * Resolve variáveis {{nome}} num texto, a partir de execution.variables +
 * dados do contato. Placeholder desconhecido vira string vazia (não vaza
 * "{{x}}" pro lead).
 */
export function renderTemplate(
  text: string,
  variables: Record<string, unknown>,
  ctx: EngineContext,
): string {
  const builtin: Record<string, unknown> = {
    nome: ctx.contactName ?? '',
    telefone: ctx.contactPhone,
  };
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = variables[key] ?? builtin[key];
    return v != null ? String(v) : '';
  });
}

function findNode(def: FlowDefinition, id: string | null): FlowNode | null {
  if (!id) return null;
  return def.nodes.find((n) => n.id === id) ?? null;
}

function nextNode(def: FlowDefinition, from: FlowNode): FlowNode | null {
  const edge = def.edges.find((e) => e.source === from.id);
  return edge ? findNode(def, edge.target) : null;
}

/** Aresta de uma SAÍDA específica (botão/opção): sourceHandle = id da saída. */
function nextNodeByHandle(
  def: FlowDefinition,
  from: FlowNode,
  handle: string,
): FlowNode | null {
  const edge = def.edges.find((e) => e.source === from.id && e.sourceHandle === handle);
  return edge ? findNode(def, edge.target) : null;
}

/**
 * Casa a resposta do contato com uma saída do nó interativo: primeiro pelo id
 * (button_reply/list_reply), senão pelo título digitado (case-insensitive).
 * Retorna o id da saída ou null se não casar.
 */
function matchInteractiveReply(
  node: FlowNode,
  input: { id: string | null; text: string | null },
): string | null {
  const options: { id: string; title: string }[] = [];
  if (node.type === 'buttons') {
    for (const b of (node.data?.buttons as EngineButton[]) ?? []) options.push(b);
  } else if (node.type === 'list') {
    for (const s of (node.data?.sections as EngineListSection[]) ?? []) {
      for (const r of s.rows) options.push({ id: r.id, title: r.title });
    }
  }
  if (input.id && options.some((o) => o.id === input.id)) return input.id;
  if (input.text) {
    const t = input.text.trim().toLowerCase();
    const byTitle = options.find((o) => o.title.trim().toLowerCase() === t);
    if (byTitle) return byTitle.id;
  }
  return null;
}

/**
 * Avança a execução a partir do estado atual até parar (Fim, espera de
 * resposta, delay longo ou sem saída). Async porque alguns nós dependem de
 * efeitos injetados (contador atômico, HTTP) — mas continua determinística
 * dado o mesmo ctx/effects.
 */
export async function runExecution(
  def: FlowDefinition,
  execution: Pick<FlowExecution, 'current_node_id' | 'status' | 'variables'>,
  event: FlowEvent,
  ctx: EngineContext,
): Promise<EngineResult> {
  const actions: FlowAction[] = [];
  const variables = { ...execution.variables };

  // Posição inicial: no 'start', começa do nó Início; senão, retoma de onde parou.
  let node: FlowNode | null;
  if (event.type === 'start') {
    node = def.nodes.find((n) => n.type === 'start') ?? null;
    if (!node) {
      actions.push({ kind: 'warn', message: 'Fluxo sem nó Início — nada a executar.' });
      return {
        actions,
        patch: { status: 'cancelled', current_node_id: null, variables, next_step_at: null },
      };
    }
  } else {
    node = findNode(def, execution.current_node_id);
    if (!node) {
      // LIÇÃO 4: nó apagado/recriado durante edição ao vivo. NUNCA silêncio:
      // avisa (o driver loga) e encerra de forma visível.
      actions.push({
        kind: 'warn',
        message:
          `Retomada não encontrou o nó "${execution.current_node_id}" no fluxo ` +
          '(nó apagado/recriado?). Execução cancelada COM aviso.',
      });
      return {
        actions,
        patch: {
          status: 'cancelled',
          current_node_id: execution.current_node_id,
          variables,
          next_step_at: null,
        },
      };
    }
  }

  // Resposta do contato a um nó interativo: roteia pela ARESTA do botão/opção.
  if (event.type === 'input') {
    // Aguardar Resposta: captura o texto numa variável e segue pela saída
    // padrão ('reply' ou aresta sem handle).
    if (node.type === 'wait_input') {
      const wi = node;
      const varName = String(wi.data?.variable ?? 'resposta');
      variables[varName] = event.input.text ?? event.input.id ?? '';
      const target =
        nextNodeByHandle(def, wi, 'reply') ??
        def.edges
          .filter((e) => e.source === wi.id && !e.sourceHandle)
          .map((e) => findNode(def, e.target))[0] ??
        null;
      if (!target) {
        return {
          actions,
          patch: { status: 'completed', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      node = target;
    } else if (node.type === 'buttons' || node.type === 'list') {
      const handle = matchInteractiveReply(node, event.input);
      if (!handle) {
        // Resposta que não casa com nenhuma opção: continua aguardando.
        return {
          actions,
          patch: { status: 'waiting_input', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      const target = nextNodeByHandle(def, node, handle);
      if (!target) {
        // Opção sem aresta ligada (fluxo editado ao vivo?) — avisa, não silencia.
        actions.push({
          kind: 'warn',
          message: `Saída "${handle}" do nó "${node.id}" não tem aresta ligada.`,
        });
        return {
          actions,
          patch: { status: 'waiting_input', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      node = target;
    } else {
      actions.push({
        kind: 'warn',
        message: `Input recebido mas o nó atual "${node.id}" (${node.type}) não é interativo.`,
      });
      return {
        actions,
        patch: { status: execution.status, current_node_id: node.id, variables, next_step_at: null },
      };
    }
  }

  // Retomada num Aguardar Resposta = TIMEOUT (o claim só vence com
  // next_step_at vencido): segue pela saída "sem resposta" ('timeout').
  if (event.type === 'resume' && node.type === 'wait_input') {
    const target = nextNodeByHandle(def, node, 'timeout');
    if (!target) {
      actions.push({
        kind: 'warn',
        message: `Aguardar Resposta "${node.id}" estourou o tempo sem saída "timeout" ligada.`,
      });
      return {
        actions,
        patch: { status: 'completed', current_node_id: node.id, variables, next_step_at: null },
      };
    }
    node = target;
  }

  let steps = 0;
  while (node && steps++ < MAX_STEPS) {
    switch (node.type) {
      case 'start': {
        node = nextNode(def, node);
        continue;
      }
      case 'message': {
        const text = String(node.data?.text ?? '');
        actions.push({
          kind: 'send_text',
          to: ctx.contactPhone,
          text: renderTemplate(text, variables, ctx),
        });
        node = nextNode(def, node);
        continue;
      }
      case 'media': {
        const d = node.data ?? {};
        actions.push({
          kind: 'send_media',
          to: ctx.contactPhone,
          media: {
            kind: (d.kind as EngineMedia['kind']) ?? 'image',
            url: d.url as string | undefined,
            mediaId: d.mediaId as string | undefined,
            caption: d.caption
              ? renderTemplate(String(d.caption), variables, ctx)
              : undefined,
            filename: d.filename as string | undefined,
          },
        });
        node = nextNode(def, node);
        continue;
      }
      case 'buttons': {
        const d = node.data ?? {};
        actions.push({
          kind: 'send_buttons',
          to: ctx.contactPhone,
          body: renderTemplate(String(d.text ?? ''), variables, ctx),
          buttons: ((d.buttons as EngineButton[]) ?? []).slice(0, 3),
        });
        // Cada botão é uma saída própria: PARA aqui e espera a resposta.
        return {
          actions,
          patch: { status: 'waiting_input', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      case 'list': {
        const d = node.data ?? {};
        actions.push({
          kind: 'send_list',
          to: ctx.contactPhone,
          body: renderTemplate(String(d.text ?? ''), variables, ctx),
          buttonText: String(d.buttonText ?? 'Escolher'),
          sections: (d.sections as EngineListSection[]) ?? [],
        });
        // Cada opção é uma saída própria: espera a resposta.
        return {
          actions,
          patch: { status: 'waiting_input', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      case 'tag': {
        actions.push({
          kind: 'apply_tag',
          contactPhone: ctx.contactPhone,
          tagName: String(node.data?.name ?? ''),
        });
        node = nextNode(def, node);
        continue;
      }
      case 'delay': {
        // DELAY HÍBRIDO (lições nº 1 e 2).
        const seconds = Math.max(0, Number(node.data?.seconds ?? 0));
        const next = nextNode(def, node);
        if (!next) {
          // Delay sem saída: nada a retomar depois — termina.
          node = null;
          continue;
        }
        if (seconds < DELAY_INLINE_THRESHOLD_S) {
          // CURTO: dormir inline (ação sleep entre os envios) e seguir na
          // MESMA execução — o bot não fica "preso" esperando o lead.
          actions.push({ kind: 'sleep', ms: Math.round(seconds * 1000) });
          node = next;
          continue;
        }
        // LONGO (lição nº 1): NUNCA await sleep no processo. Resolve a próxima
        // aresta JÁ, grava current_node_id apontando pro PRÓXIMO nó e
        // next_step_at = agora + segundos, e RETORNA SEM ESPERAR.
        // processPendingExecutions() retoma (disparado pelo tráfego de webhook).
        const nowIso = ctx.now ?? new Date().toISOString();
        const resumeAt = new Date(Date.parse(nowIso) + seconds * 1000).toISOString();
        return {
          actions,
          patch: {
            status: 'running',
            current_node_id: next.id,
            variables,
            next_step_at: resumeAt,
          },
        };
      }
      case 'wait_input': {
        // Aguardar Resposta: pausa aqui. Timeout opcional usa o MESMO
        // mecanismo de next_step_at (saída "sem resposta" na retomada).
        const timeoutS = Number(node.data?.timeoutSeconds ?? 0);
        const nowIso = ctx.now ?? new Date().toISOString();
        const timeoutAt =
          timeoutS > 0
            ? new Date(Date.parse(nowIso) + timeoutS * 1000).toISOString()
            : null;
        return {
          actions,
          patch: {
            status: 'waiting_input',
            current_node_id: node.id,
            variables,
            next_step_at: timeoutAt,
          },
        };
      }
      case 'randomizer': {
        // LIÇÃO 3: round-robin usa o contador ATÔMICO (uma instrução SQL).
        const n = Math.max(1, Number(node.data?.outputs ?? 2));
        const mode = String(node.data?.mode ?? 'random');
        if (!ctx.effects) {
          actions.push({ kind: 'warn', message: `Randomizador "${node.id}" sem effects injetados.` });
          return {
            actions,
            patch: { status: 'cancelled', current_node_id: node.id, variables, next_step_at: null },
          };
        }
        let idx: number;
        if (mode === 'round_robin') {
          idx = await ctx.effects.incrementAndGet(ctx.flowId ?? '', node.id, n);
        } else {
          idx = Math.floor(ctx.effects.random() * n) % n;
        }
        const target = nextNodeByHandle(def, node, String(idx));
        if (!target) {
          actions.push({
            kind: 'warn',
            message: `Randomizador "${node.id}": saída "${idx}" sem aresta ligada.`,
          });
          return {
            actions,
            patch: { status: 'completed', current_node_id: node.id, variables, next_step_at: null },
          };
        }
        node = target;
        continue;
      }
      case 'condition': {
        // Avalia regras EM ORDEM; múltiplas saídas + 'else'.
        type Rule = { handle: string; kind: string; value: string; variable?: string };
        const rules = ((node.data?.rules as Rule[]) ?? []);
        let chosen: string | null = null;
        for (const rule of rules) {
          const needle = rule.value.toLowerCase();
          if (rule.kind === 'text_contains') {
            if ((ctx.lastText ?? '').toLowerCase().includes(needle)) {
              chosen = rule.handle;
              break;
            }
          } else if (rule.kind === 'variable_contains') {
            const v = String(variables[rule.variable ?? ''] ?? '');
            if (v.toLowerCase().includes(needle)) {
              chosen = rule.handle;
              break;
            }
          } else if (rule.kind === 'has_tag') {
            if (ctx.effects && (await ctx.effects.hasTag(ctx.contactPhone, rule.value))) {
              chosen = rule.handle;
              break;
            }
          }
        }
        const target = nextNodeByHandle(def, node, chosen ?? 'else');
        if (!target) {
          actions.push({
            kind: 'warn',
            message: `Condição "${node.id}": saída "${chosen ?? 'else'}" sem aresta ligada.`,
          });
          return {
            actions,
            patch: { status: 'completed', current_node_id: node.id, variables, next_step_at: null },
          };
        }
        node = target;
        continue;
      }
      case 'webhook': {
        // Nó Webhook: chama URL externa; pode salvar a resposta numa variável.
        const d = node.data ?? {};
        const url = renderTemplate(String(d.url ?? ''), variables, ctx);
        const method = String(d.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
        const saveTo = d.saveTo ? String(d.saveTo) : null;
        if (!ctx.effects) {
          actions.push({ kind: 'warn', message: `Webhook "${node.id}" sem effects injetados.` });
        } else {
          try {
            const resp = await ctx.effects.httpCall({ url, method, body: d.body });
            if (saveTo) variables[saveTo] = resp.body;
          } catch (err) {
            actions.push({
              kind: 'warn',
              message: `Webhook "${node.id}" falhou: ${(err as Error).message}`,
            });
            if (saveTo) variables[saveTo] = '';
          }
        }
        node = nextNode(def, node);
        continue;
      }
      case 'end': {
        return {
          actions,
          patch: { status: 'completed', current_node_id: node.id, variables, next_step_at: null },
        };
      }
      default: {
        actions.push({
          kind: 'warn',
          message: `Tipo de nó desconhecido "${node.type}" (chega em fase futura). Encerrando.`,
        });
        return {
          actions,
          patch: { status: 'cancelled', current_node_id: node.id, variables, next_step_at: null },
        };
      }
    }
  }

  if (steps >= MAX_STEPS) {
    actions.push({ kind: 'warn', message: 'Fluxo excedeu o limite de passos (ciclo?).' });
    return {
      actions,
      patch: { status: 'cancelled', current_node_id: node?.id ?? null, variables, next_step_at: null },
    };
  }

  // Sem aresta de saída: fluxo termina implicitamente.
  return {
    actions,
    patch: { status: 'completed', current_node_id: null, variables, next_step_at: null },
  };
}
