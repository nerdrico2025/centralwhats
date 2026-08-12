import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { runExecution, renderTemplate, type FlowDefinition } from '../src/domain/flowEngine';
import { startFlowExecution, processPendingExecutions } from '../src/domain/flows';
import type { Repo } from '../src/repo';
import type { Instance, Flow } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

// Fluxo mínimo: Início → Mensagem → Fim
const DEF: FlowDefinition = {
  nodes: [
    { id: 'n1', type: 'start' },
    { id: 'n2', type: 'message', data: { text: 'Olá {{nome}}! Seu telefone: {{telefone}}' } },
    { id: 'n3', type: 'end' },
  ],
  edges: [
    { source: 'n1', target: 'n2' },
    { source: 'n2', target: 'n3' },
  ],
};

const CTX = { contactPhone: '5511999998888', contactName: 'Ana' };

function makeCountingProvider() {
  const sent: string[] = [];
  const provider: Provider = {
    type: 'meta',
    capabilities: { text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true },
    async sendText(_i, to, text): Promise<SendResult> {
      sent.push(text);
      return { waMessageId: 'wamid.' + sent.length + '.' + to, status: 'sent' };
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

describe('engine puro (sem rede, sem repo)', () => {
  it('Início→Mensagem→Fim: emite send_text renderizado e completa', async () => {
    const exec = { current_node_id: null, status: 'running' as const, variables: {} };
    const r = await runExecution(DEF, exec, { type: 'start' }, CTX);

    expect(r.actions).toEqual([
      { kind: 'send_text', to: '5511999998888', text: 'Olá Ana! Seu telefone: 5511999998888' },
    ]);
    expect(r.patch.status).toBe('completed');
    expect(r.patch.current_node_id).toBe('n3');
  });

  it('é determinística: mesma entrada → mesma saída', async () => {
    const exec = { current_node_id: null, status: 'running' as const, variables: { x: 1 } };
    const a = await runExecution(DEF, exec, { type: 'start' }, CTX);
    const b = await runExecution(DEF, exec, { type: 'start' }, CTX);
    expect(a).toEqual(b);
  });

  it('variables da execução têm precedência sobre builtin e {{desconhecida}} vira vazio', async () => {
    expect(renderTemplate('{{nome}}/{{plano}}/{{nada}}', { nome: 'X', plano: 'pro' }, CTX)).toBe(
      'X/pro/',
    );
  });

  it('LIÇÃO 4: retomada em nó inexistente gera AVISO, nunca silêncio', async () => {
    const exec = { current_node_id: 'apagado', status: 'running' as const, variables: {} };
    const r = await runExecution(DEF, exec, { type: 'resume' }, CTX);
    expect(r.actions.some((a) => a.kind === 'warn')).toBe(true);
    expect(r.patch.status).toBe('cancelled'); // cancelado COM aviso, não em silêncio
  });

  it('protege contra ciclo no grafo (não trava o processo)', async () => {
    const cyclic: FlowDefinition = {
      nodes: [
        { id: 'a', type: 'start' },
        { id: 'b', type: 'message', data: { text: 'loop' } },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'b' }, // ciclo
      ],
    };
    const r = await runExecution(
      cyclic,
      { current_node_id: null, status: 'running', variables: {} },
      { type: 'start' },
      CTX,
    );
    expect(r.patch.status).toBe('cancelled');
    expect(r.actions.some((a) => a.kind === 'warn')).toBe(true);
  });
});

describe('driver + repo (integração)', () => {
  let repo: Repo;
  let inst: Instance;
  let flow: Flow;

  beforeEach(async () => {
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    inst = await repo.instances.create({
    org_id: 'org_default',
      name: 'Loja', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511999998888', name: 'Ana', last_seen: null,
    });
    flow = await repo.flows.create({
      instance_id: inst.id, name: 'boas-vindas', trigger_keywords: ['oi'],
      nodes: DEF.nodes, edges: DEF.edges, active: true,
    });
  });

  it('startFlowExecution executa ponta a ponta: envia e completa', async () => {
    const { provider, sent } = makeCountingProvider();
    const done = await startFlowExecution(repo, inst, flow, '5511999998888', {
      providerFor: () => provider,
    });
    expect(done?.status).toBe('completed');
    expect(sent).toEqual(['Olá Ana! Seu telefone: 5511999998888']);

    // Saída logada em messages (regra de sempre logar envio).
    const msgs = await repo.messages.listByContact(inst.id, '5511999998888');
    expect(msgs.filter((m) => m.direction === 'out').length).toBe(1);
  });

  it('processPendingExecutions retoma execução vencida', async () => {
    // Execução parada em n2 com next_step_at no passado (como um delay venceria).
    await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511999998888',
      current_node_id: 'n2', status: 'running', variables: {},
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    const { provider, sent } = makeCountingProvider();
    const r = await processPendingExecutions(repo, inst.id, { providerFor: () => provider });
    expect(r.resumed).toBe(1);
    expect(sent.length).toBe(1); // reexecuta a mensagem do nó atual e completa
  });

  it('CONCORRÊNCIA: duas varreduras simultâneas NÃO retomam a mesma execução duas vezes', async () => {
    await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511999998888',
      current_node_id: 'n2', status: 'running', variables: {},
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    const { provider, sent } = makeCountingProvider();
    const deps = { providerFor: () => provider };

    // Dois "processos" varrendo ao mesmo tempo (Promise.all real).
    const [r1, r2] = await Promise.all([
      processPendingExecutions(repo, inst.id, deps),
      processPendingExecutions(repo, inst.id, deps),
    ]);
    expect(r1.resumed + r2.resumed).toBe(1); // só um venceu o claim
    expect(sent.length).toBe(1); // a mensagem saiu UMA vez

    // E uma terceira varredura não encontra mais nada.
    const r3 = await processPendingExecutions(repo, inst.id, deps);
    expect(r3.resumed).toBe(0);
  });

  it('claimDue: segundo claim do mesmo id retorna null (instrução condicional)', async () => {
    const e = await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511999998888',
      current_node_id: 'n2', status: 'running', variables: {},
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    const nowIso = new Date().toISOString();
    const first = await repo.flowExecutions.claimDue(e.id, nowIso);
    const second = await repo.flowExecutions.claimDue(e.id, nowIso);
    expect(first).not.toBeNull();
    expect(first!.next_step_at).toBeNull();
    expect(second).toBeNull();
  });

  it('nó apagado durante edição ao vivo: retomada cancela COM aviso (não silêncio)', async () => {
    const e = await repo.flowExecutions.create({
      flow_id: flow.id, instance_id: inst.id, contact_phone: '5511999998888',
      current_node_id: 'n2', status: 'running', variables: {},
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    // Simula edição ao vivo: a execução aponta para um nó que não existe mais.
    await repo.flowExecutions.updateIfStatus(e.id, 'running', { current_node_id: 'nó-apagado' });
    const { provider } = makeCountingProvider();
    await processPendingExecutions(repo, inst.id, { providerFor: () => provider });
    const after = await repo.flowExecutions.getById(e.id);
    expect(after?.status).toBe('cancelled'); // cancelado com warn no log, não sumiu
  });
});
