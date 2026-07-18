import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import {
  runExecution,
  type EngineEffects,
  type FlowDefinition,
} from '../src/domain/flowEngine';
import { startFlowExecution, processPendingExecutions, handleFlowInbound } from '../src/domain/flows';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

const CTX_BASE = { contactPhone: '5511999998888', contactName: 'Ana', now: '2026-07-17T12:00:00.000Z' };

function fakeEffects(over: Partial<EngineEffects> = {}): EngineEffects {
  const counters = new Map<string, number>();
  return {
    async incrementAndGet(flowId, nodeId, n) {
      const k = flowId + '/' + nodeId;
      const v = ((counters.get(k) ?? -1) + 1) % n;
      counters.set(k, v);
      return v;
    },
    random: () => 0.5,
    httpCall: async () => ({ status: 200, body: 'ok' }),
    hasTag: async () => false,
    ...over,
  };
}

function makeCountingProvider() {
  const sent: string[] = [];
  const ok = (): Promise<SendResult> =>
    Promise.resolve({ waMessageId: 'wamid.' + (sent.length + 1), status: 'sent' as const });
  const provider: Provider = {
    type: 'meta',
    capabilities: { text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true },
    sendText: (_i, _to, text) => { sent.push(text); return ok(); },
    sendMedia: () => ok(),
    sendButtons: () => ok(),
    sendList: () => ok(),
    sendTemplate: () => ok(),
    sendReaction: () => ok(),
    sendCtaUrl: () => ok(),
  };
  return { provider, sent };
}

// ------------------------------------------------------------------ definições
function randomizerFlow(mode: 'random' | 'round_robin'): FlowDefinition {
  return {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'r', type: 'randomizer', data: { mode, outputs: 3 } },
      { id: 'a', type: 'message', data: { text: 'A' } },
      { id: 'b', type: 'message', data: { text: 'B' } },
      { id: 'c', type: 'message', data: { text: 'C' } },
      { id: 'z', type: 'end' },
    ],
    edges: [
      { source: 's', target: 'r' },
      { source: 'r', target: 'a', sourceHandle: '0' },
      { source: 'r', target: 'b', sourceHandle: '1' },
      { source: 'r', target: 'c', sourceHandle: '2' },
      { source: 'a', target: 'z' },
      { source: 'b', target: 'z' },
      { source: 'c', target: 'z' },
    ],
  };
}

describe('Randomizador (engine puro, effects fake)', () => {
  it('round-robin usa o contador atômico e alterna 0,1,2,0,1,2...', async () => {
    const def = randomizerFlow('round_robin');
    const effects = fakeEffects();
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await runExecution(
        def,
        { current_node_id: null, status: 'running', variables: {} },
        { type: 'start' },
        { ...CTX_BASE, flowId: 'f1', effects },
      );
      const send = r.actions.find((a) => a.kind === 'send_text');
      texts.push((send as { text: string }).text);
    }
    expect(texts).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
  });

  it('modo aleatório usa random() injetado', async () => {
    const def = randomizerFlow('random');
    const r = await runExecution(
      def,
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      { ...CTX_BASE, flowId: 'f1', effects: fakeEffects({ random: () => 0.99 }) },
    );
    expect(r.actions[0]).toMatchObject({ kind: 'send_text', text: 'C' }); // floor(0.99*3)=2
  });
});

describe('Condição (engine puro)', () => {
  const def: FlowDefinition = {
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 'cond', type: 'condition',
        data: {
          rules: [
            { handle: 'r1', kind: 'text_contains', value: 'preço' },
            { handle: 'r2', kind: 'variable_contains', variable: 'plano', value: 'pro' },
            { handle: 'r3', kind: 'has_tag', value: 'vip' },
          ],
        },
      },
      { id: 'm1', type: 'message', data: { text: 'preços' } },
      { id: 'm2', type: 'message', data: { text: 'upgrade' } },
      { id: 'm3', type: 'message', data: { text: 'vip!' } },
      { id: 'm4', type: 'message', data: { text: 'padrão' } },
      { id: 'z', type: 'end' },
    ],
    edges: [
      { source: 's', target: 'cond' },
      { source: 'cond', target: 'm1', sourceHandle: 'r1' },
      { source: 'cond', target: 'm2', sourceHandle: 'r2' },
      { source: 'cond', target: 'm3', sourceHandle: 'r3' },
      { source: 'cond', target: 'm4', sourceHandle: 'else' },
      { source: 'm1', target: 'z' },
      { source: 'm2', target: 'z' },
      { source: 'm3', target: 'z' },
      { source: 'm4', target: 'z' },
    ],
  };

  async function route(ctx: Record<string, unknown>, variables: Record<string, unknown> = {}) {
    const r = await runExecution(
      def,
      { current_node_id: null, status: 'running', variables },
      { type: 'start' },
      { ...CTX_BASE, flowId: 'f', effects: fakeEffects(), ...ctx },
    );
    return (r.actions.find((a) => a.kind === 'send_text') as { text: string }).text;
  }

  it('avalia em ordem: text_contains, variable_contains, has_tag, else', async () => {
    expect(await route({ lastText: 'qual o PREÇO?' })).toBe('preços');
    expect(await route({ lastText: 'oi' }, { plano: 'plano-pro' })).toBe('upgrade');
    expect(
      await route({ lastText: 'oi', effects: fakeEffects({ hasTag: async () => true }) }),
    ).toBe('vip!');
    expect(await route({ lastText: 'oi' })).toBe('padrão'); // else
  });
});

describe('Aguardar Resposta (engine puro)', () => {
  const def: FlowDefinition = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'ask', type: 'message', data: { text: 'Qual seu nome?' } },
      { id: 'w', type: 'wait_input', data: { variable: 'nome_lead', timeoutSeconds: 3600 } },
      { id: 'ok', type: 'message', data: { text: 'Prazer, {{nome_lead}}!' } },
      { id: 'lost', type: 'message', data: { text: 'Ficou por aí? Me chama!' } },
      { id: 'z', type: 'end' },
    ],
    edges: [
      { source: 's', target: 'ask' },
      { source: 'ask', target: 'w' },
      { source: 'w', target: 'ok', sourceHandle: 'reply' },
      { source: 'w', target: 'lost', sourceHandle: 'timeout' },
      { source: 'ok', target: 'z' },
      { source: 'lost', target: 'z' },
    ],
  };
  const ctx = { ...CTX_BASE, flowId: 'f', effects: fakeEffects() };

  it('entra em waiting_input e agenda o timeout pelo MESMO mecanismo next_step_at', async () => {
    const r = await runExecution(
      def,
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      ctx,
    );
    expect(r.patch.status).toBe('waiting_input');
    expect(r.patch.current_node_id).toBe('w');
    expect(r.patch.next_step_at).toBe('2026-07-17T13:00:00.000Z'); // now + 3600s
  });

  it('resposta salva a variável e segue pela saída "reply"', async () => {
    const r = await runExecution(
      def,
      { current_node_id: 'w', status: 'waiting_input', variables: {} },
      { type: 'input', input: { id: null, text: 'Rafael' } },
      ctx,
    );
    expect(r.patch.variables.nome_lead).toBe('Rafael');
    expect(r.actions).toEqual([
      { kind: 'send_text', to: CTX_BASE.contactPhone, text: 'Prazer, Rafael!' },
    ]);
    expect(r.patch.status).toBe('completed');
  });

  it('timeout (resume) roteia pra saída "sem resposta"', async () => {
    const r = await runExecution(
      def,
      { current_node_id: 'w', status: 'waiting_input', variables: {} },
      { type: 'resume' },
      ctx,
    );
    expect(r.actions).toEqual([
      { kind: 'send_text', to: CTX_BASE.contactPhone, text: 'Ficou por aí? Me chama!' },
    ]);
    expect(r.patch.status).toBe('completed');
  });
});

describe('nó Webhook (engine puro, httpCall fake)', () => {
  it('chama a URL e salva a resposta na variável, usável adiante', async () => {
    const def: FlowDefinition = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'wh', type: 'webhook', data: { url: 'https://api.x/lead/{{telefone}}', method: 'GET', saveTo: 'score' } },
        { id: 'm', type: 'message', data: { text: 'Seu score: {{score}}' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'wh' },
        { source: 'wh', target: 'm' },
        { source: 'm', target: 'z' },
      ],
    };
    const calls: string[] = [];
    const effects = fakeEffects({
      httpCall: async (req) => {
        calls.push(req.method + ' ' + req.url);
        return { status: 200, body: '87' };
      },
    });
    const r = await runExecution(
      def,
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      { ...CTX_BASE, flowId: 'f', effects },
    );
    expect(calls).toEqual(['GET https://api.x/lead/5511999998888']); // URL renderizada
    expect(r.actions[0]).toMatchObject({ kind: 'send_text', text: 'Seu score: 87' });
    expect(r.patch.status).toBe('completed');
  });

  it('falha do webhook: avisa e segue com variável vazia (não trava o fluxo)', async () => {
    const def: FlowDefinition = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'wh', type: 'webhook', data: { url: 'https://x', method: 'GET', saveTo: 'v' } },
        { id: 'm', type: 'message', data: { text: 'v=[{{v}}]' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'wh' },
        { source: 'wh', target: 'm' },
        { source: 'm', target: 'z' },
      ],
    };
    const effects = fakeEffects({ httpCall: async () => { throw new Error('rede fora'); } });
    const r = await runExecution(
      def,
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      { ...CTX_BASE, flowId: 'f', effects },
    );
    expect(r.actions.some((a) => a.kind === 'warn')).toBe(true);
    expect(r.actions.find((a) => a.kind === 'send_text')).toMatchObject({ text: 'v=[]' });
    expect(r.patch.status).toBe('completed');
  });
});

// ------------------------------------------------------------------ integração
describe('integração — round-robin sob concorrência + limpeza de presas', () => {
  let repo: Repo;
  let inst: Instance;

  beforeEach(async () => {
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    inst = await repo.instances.create({
      name: 'Loja', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
  });

  it('round-robin distribui IGUALMENTE sob concorrência (contador atômico real)', async () => {
    const def = randomizerFlow('round_robin');
    const flow = await repo.flows.create({
      instance_id: inst.id, name: 'rr', trigger_keywords: [],
      nodes: def.nodes, edges: def.edges, active: true,
    });
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };

    // 30 execuções "simultâneas" (contatos distintos) → 10 por caminho.
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        startFlowExecution(repo, inst, flow, '55119' + String(100000 + i), deps),
      ),
    );
    const dist = { A: 0, B: 0, C: 0 } as Record<string, number>;
    for (const t of sent) dist[t]++;
    expect(dist).toEqual({ A: 10, B: 10, C: 10 }); // sem duplicar/pular caminho
  });

  it('Aguardar Resposta ponta a ponta: timeout vencido roteia "sem resposta" via varredura', async () => {
    const def: FlowDefinition = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'w', type: 'wait_input', data: { variable: 'r', timeoutSeconds: 3600 } },
        { id: 'lost', type: 'message', data: { text: 'sem resposta' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'w' },
        { source: 'w', target: 'lost', sourceHandle: 'timeout' },
        { source: 'lost', target: 'z' },
      ],
    };
    const flow = await repo.flows.create({
      instance_id: inst.id, name: 'wt', trigger_keywords: ['oi'],
      nodes: def.nodes, edges: def.edges, active: true,
    });
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };
    const started = await startFlowExecution(repo, inst, flow, '5511999998888', deps);
    expect(started?.status).toBe('waiting_input');
    expect(started?.next_step_at).not.toBeNull();

    // Tempo passa (timeout vence) → varredura retoma e segue "sem resposta".
    await repo.flowExecutions.updateIfStatus(started!.id, 'waiting_input', {
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    const r = await processPendingExecutions(repo, inst.id, deps);
    expect(r.resumed).toBe(1);
    expect(sent).toEqual(['sem resposta']);
    expect((await repo.flowExecutions.getById(started!.id))?.status).toBe('completed');
  });

  it('resposta antes do timeout salva a variável (rota pelo webhook inbound)', async () => {
    const def: FlowDefinition = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'w', type: 'wait_input', data: { variable: 'nome_lead', timeoutSeconds: 3600 } },
        { id: 'ok', type: 'message', data: { text: 'Oi {{nome_lead}}' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'w' },
        { source: 'w', target: 'ok', sourceHandle: 'reply' },
        { source: 'ok', target: 'z' },
      ],
    };
    const flow = await repo.flows.create({
      instance_id: inst.id, name: 'ask', trigger_keywords: [],
      nodes: def.nodes, edges: def.edges, active: true,
    });
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };
    await startFlowExecution(repo, inst, flow, '5511999998888', deps);

    const r = await handleFlowInbound(repo, inst, '5511999998888', { text: 'Rafael', replyId: null }, deps);
    expect(r.routed).toBe(true);
    expect(sent).toEqual(['Oi Rafael']);
  });

  it('limpeza: cancela execução presa antiga MAS preserva delay longo legítimo', async () => {
    const def = randomizerFlow('round_robin');
    const flow = await repo.flows.create({
      instance_id: inst.id, name: 'x', trigger_keywords: [],
      nodes: def.nodes, edges: def.edges, active: true,
    });

    // Presa: parada há muito tempo, sem retomada agendada.
    const stuck = await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511900000001',
      current_node_id: 'r', status: 'waiting_input', variables: {}, next_step_at: null,
    });
    // Antiguidade forjada direto no banco? Não há método — usamos cutoff futuro? Não:
    // cancelStuck compara updated_at < cutoff. Chamamos com cutoff no futuro para
    // simular "passou muito tempo" (equivale a envelhecer o registro).
    const farFuture = '2030-01-01T00:00:00.000Z';

    // Legítima: delay longo com retomada agendada DEPOIS do cutoff.
    const legit = await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511900000002',
      current_node_id: 'a', status: 'running', variables: {},
      next_step_at: '2031-06-01T00:00:00.000Z',
    });

    const cleaned = await repo.flowExecutions.cancelStuck(inst.id, farFuture);
    expect(cleaned).toBe(1); // só a presa

    expect((await repo.flowExecutions.getById(stuck.id))?.status).toBe('cancelled');
    expect((await repo.flowExecutions.getById(legit.id))?.status).toBe('running'); // intacta
  });
});
