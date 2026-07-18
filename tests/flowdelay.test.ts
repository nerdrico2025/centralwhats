import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import {
  runExecution,
  DELAY_INLINE_THRESHOLD_S,
  type FlowDefinition,
} from '../src/domain/flowEngine';
import { startFlowExecution, processPendingExecutions } from '../src/domain/flows';
import type { Repo } from '../src/repo';
import type { Instance, Flow } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

const CTX = { contactPhone: '5511999998888', contactName: 'Ana', now: '2026-07-17T12:00:00.000Z' };

function delayFlow(seconds: number): FlowDefinition {
  return {
    nodes: [
      { id: 'n1', type: 'start' },
      { id: 'n2', type: 'message', data: { text: 'Antes' } },
      { id: 'n3', type: 'delay', data: { seconds } },
      { id: 'n4', type: 'message', data: { text: 'Depois' } },
      { id: 'n5', type: 'end' },
    ],
    edges: [
      { source: 'n1', target: 'n2' },
      { source: 'n2', target: 'n3' },
      { source: 'n3', target: 'n4' },
      { source: 'n4', target: 'n5' },
    ],
  };
}

function makeCountingProvider() {
  const sent: string[] = [];
  const provider: Provider = {
    type: 'meta',
    capabilities: { text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true },
    async sendText(_i, _to, text): Promise<SendResult> {
      sent.push(text);
      return { waMessageId: 'wamid.' + sent.length, status: 'sent' };
    },
    sendMedia: () => { throw new Error('não usado'); },
    sendTemplate: () => { throw new Error('não usado'); },
    sendButtons: () => { throw new Error('não usado'); },
    sendList: () => { throw new Error('não usado'); },
    sendReaction: () => { throw new Error('não usado'); },
    sendCtaUrl: () => { throw new Error('não usado'); },
  };
  return { provider, sent };
}

describe('engine — delay híbrido (puro)', () => {
  it('delay CURTO vira ação sleep e o fluxo segue na MESMA execução', async () => {
    const r = await runExecution(
      delayFlow(0.05),
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      CTX,
    );
    expect(r.actions).toEqual([
      { kind: 'send_text', to: CTX.contactPhone, text: 'Antes' },
      { kind: 'sleep', ms: 50 },
      { kind: 'send_text', to: CTX.contactPhone, text: 'Depois' },
    ]);
    expect(r.patch.status).toBe('completed');
  });

  it('delay LONGO: resolve a aresta JÁ, aponta pro PRÓXIMO nó e retorna sem esperar', async () => {
    const r = await runExecution(
      delayFlow(3600),
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      CTX,
    );
    // Só o que vem ANTES do delay foi emitido.
    expect(r.actions).toEqual([{ kind: 'send_text', to: CTX.contactPhone, text: 'Antes' }]);
    // Estado gravado: já aponta pro nó DEPOIS do delay + quando retomar.
    expect(r.patch.status).toBe('running');
    expect(r.patch.current_node_id).toBe('n4');
    expect(r.patch.next_step_at).toBe('2026-07-17T13:00:00.000Z'); // now + 3600s
  });

  it('limiar documentado: >= limiar é longo, abaixo é curto', async () => {
    const long = await runExecution(
      delayFlow(DELAY_INLINE_THRESHOLD_S),
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      CTX,
    );
    expect(long.patch.next_step_at).not.toBeNull(); // persistiu

    const short = await runExecution(
      delayFlow(DELAY_INLINE_THRESHOLD_S - 0.01),
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      CTX,
    );
    expect(short.patch.status).toBe('completed'); // fluiu inline até o fim
  });
});

describe('integração — retomada sobrevive à reciclagem do processo', () => {
  let repo: Repo;
  let inst: Instance;

  beforeEach(async () => {
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    inst = await repo.instances.create({
      name: 'Loja', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511999998888', name: 'Ana', last_seen: null,
    });
  });

  async function makeFlow(seconds: number): Promise<Flow> {
    const def = delayFlow(seconds);
    return repo.flows.create({
      instance_id: inst.id, name: 'f', trigger_keywords: ['oi'],
      nodes: def.nodes, edges: def.edges, active: true,
    });
  }

  it('CRITÉRIO DO PRD: vários delays curtos fluem SOZINHOS, sem o lead cutucar', async () => {
    // Início → msg → delay 0.03 → msg → delay 0.03 → msg → Fim
    const def: FlowDefinition = {
      nodes: [
        { id: 'a', type: 'start' },
        { id: 'm1', type: 'message', data: { text: '1' } },
        { id: 'd1', type: 'delay', data: { seconds: 0.03 } },
        { id: 'm2', type: 'message', data: { text: '2' } },
        { id: 'd2', type: 'delay', data: { seconds: 0.03 } },
        { id: 'm3', type: 'message', data: { text: '3' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 'a', target: 'm1' },
        { source: 'm1', target: 'd1' },
        { source: 'd1', target: 'm2' },
        { source: 'm2', target: 'd2' },
        { source: 'd2', target: 'm3' },
        { source: 'm3', target: 'z' },
      ],
    };
    const flow = await repo.flows.create({
      instance_id: inst.id, name: 'ritmo', trigger_keywords: [],
      nodes: def.nodes, edges: def.edges, active: true,
    });
    const { provider, sent } = makeCountingProvider();
    const done = await startFlowExecution(repo, inst, flow, '5511999998888', {
      providerFor: () => provider,
    });
    // Uma chamada só: as 3 mensagens saíram em sequência, sem inbound extra.
    expect(done?.status).toBe('completed');
    expect(sent).toEqual(['1', '2', '3']);
  });

  it('CRITÉRIO DO PRD: delay longo sobrevive ao fim da request e é retomado depois', async () => {
    const flow = await makeFlow(3600); // 1h — bem acima do limiar
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };

    // "Request 1": inicia o fluxo. Envia só "Antes" e RETORNA (sem esperar).
    const afterStart = await startFlowExecution(repo, inst, flow, '5511999998888', deps);
    expect(sent).toEqual(['Antes']);
    expect(afterStart?.status).toBe('running');
    expect(afterStart?.current_node_id).toBe('n4'); // aresta já resolvida
    expect(afterStart?.next_step_at).not.toBeNull();

    // ===== RECICLAGEM DO PROCESSO =====
    // Nada vive em memória: todo o estado necessário está no banco.
    // Simulamos o tempo passando: o next_step_at vence.
    await repo.flowExecutions.updateIfStatus(afterStart!.id, 'running', {
      next_step_at: '2020-01-01T00:00:00.000Z',
    });

    // "Request 2" (outro processo): tráfego de webhook dispara a varredura.
    const r = await processPendingExecutions(repo, inst.id, deps);
    expect(r.resumed).toBe(1);
    expect(sent).toEqual(['Antes', 'Depois']); // retomou exatamente do nó pós-delay

    const finished = await repo.flowExecutions.getById(afterStart!.id);
    expect(finished?.status).toBe('completed'); // NÃO ficou presa
  });

  it('delay longo ainda não vencido NÃO é retomado (não antecipa)', async () => {
    const flow = await makeFlow(3600);
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };
    await startFlowExecution(repo, inst, flow, '5511999998888', deps);

    const r = await processPendingExecutions(repo, inst.id, deps);
    expect(r.resumed).toBe(0); // next_step_at no futuro — espera de verdade
    expect(sent).toEqual(['Antes']);
  });
});
