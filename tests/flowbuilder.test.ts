import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { validateFlowDefinition } from '../src/domain/flowValidation';
import { processInboundPayload } from '../src/domain/webhook';
import { processPendingExecutions } from '../src/domain/flows';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

let repo: Repo;
let inst: Instance;
const PNID = '109999888777';
const PHONE = '5511999998888';

function makeRecordingProvider() {
  const events: { kind: string; payload: unknown }[] = [];
  const ok = (): Promise<SendResult> =>
    Promise.resolve({ waMessageId: 'wamid.' + (events.length + 1), status: 'sent' as const });
  const provider: Provider = {
    type: 'meta',
    capabilities: { text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true },
    sendText: (_i, _to, text) => { events.push({ kind: 'text', payload: text }); return ok(); },
    sendButtons: (_i, _to, body, buttons) => { events.push({ kind: 'buttons', payload: { body, buttons } }); return ok(); },
    sendMedia: () => ok(),
    sendList: () => ok(),
    sendTemplate: () => ok(),
    sendReaction: () => ok(),
    sendCtaUrl: () => ok(),
  };
  return { provider, events };
}

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  inst = await repo.instances.create({
    name: 'Loja', provider_type: 'meta', phone_number_id: PNID, waba_id: null,
    token: 't', verify_token: 'v', active: true, connection_status: 'connected',
  });
});

describe('validateFlowDefinition', () => {
  it('avisa: sem Início, aresta solta, nó órfão', () => {
    const w = validateFlowDefinition({
      nodes: [
        { id: 'm', type: 'message' },
        { id: 'x', type: 'message' },
      ],
      edges: [{ source: 'm', target: 'fantasma' }],
    });
    expect(w.some((s) => s.includes('sem nó Início'))).toBe(true);
    expect(w.some((s) => s.includes('fantasma'))).toBe(true);
  });

  it('detecta órfão quando há Início', () => {
    const w = validateFlowDefinition({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'a', type: 'message' },
        { id: 'orfao', type: 'message' },
      ],
      edges: [{ source: 's', target: 'a' }],
    });
    expect(w).toEqual(['Nó órfão: "orfao" (message) nunca é alcançado a partir do Início.']);
  });

  it('fluxo bem formado: sem avisos', () => {
    const w = validateFlowDefinition({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'a', type: 'message' },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'a' },
        { source: 'a', target: 'z' },
      ],
    });
    expect(w).toEqual([]);
  });
});

describe('rotas de fluxos', () => {
  it('POST cria com warnings; PATCH atualiza; GET lista', async () => {
    const app = createApp(repo);
    const created = await request(app)
      .post(`/api/instances/${inst.id}/flows`)
      .send({ name: 'F', trigger_keywords: ['oi'], nodes: [{ id: 'm', type: 'message' }], edges: [] })
      .expect(201);
    expect(created.body.warnings.some((w: string) => w.includes('sem nó Início'))).toBe(true);

    const patched = await request(app)
      .patch(`/api/instances/${inst.id}/flows/${created.body.flow.id}`)
      .send({
        nodes: [
          { id: 's', type: 'start' },
          { id: 'm', type: 'message', data: { text: 'oi' } },
          { id: 'z', type: 'end' },
        ],
        edges: [
          { source: 's', target: 'm' },
          { source: 'm', target: 'z' },
        ],
        active: true,
      })
      .expect(200);
    expect(patched.body.warnings).toEqual([]);
    expect(patched.body.flow.active).toBe(true);

    const list = await request(app).get(`/api/instances/${inst.id}/flows`).expect(200);
    expect(list.body.length).toBe(1);
  });

  it('GET /executions/active reporta execuções por nó (aviso da lição 4)', async () => {
    const app = createApp(repo);
    const created = await request(app)
      .post(`/api/instances/${inst.id}/flows`)
      .send({
        name: 'F', trigger_keywords: [],
        nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'wait_input' }],
        edges: [{ source: 's', target: 'w' }],
      })
      .expect(201);
    const flowId = created.body.flow.id;
    await repo.flowExecutions.create({
      flow_id: flowId, instance_id: inst.id, contact_phone: PHONE,
      current_node_id: 'w', status: 'waiting_input', variables: {}, next_step_at: null,
    });

    const act = await request(app)
      .get(`/api/instances/${inst.id}/flows/${flowId}/executions/active`)
      .expect(200);
    expect(act.body.total).toBe(1);
    expect(act.body.by_node.w).toBe(1);
  });
});

describe('CRITÉRIO DE ACEITE P4.5 — fluxo do builder executa ponta a ponta', () => {
  function inboundText(body: string, id: string) {
    return {
      entry: [{ changes: [{ value: {
        metadata: { display_phone_number: '15550001111', phone_number_id: PNID },
        contacts: [{ profile: { name: 'Ana' }, wa_id: PHONE }],
        messages: [{ from: PHONE, id, type: 'text', text: { body } }],
      } }] }],
    };
  }
  function inboundButtonReply(replyId: string, title: string, id: string) {
    return {
      entry: [{ changes: [{ value: {
        metadata: { display_phone_number: '15550001111', phone_number_id: PNID },
        contacts: [{ wa_id: PHONE }],
        messages: [{ from: PHONE, id, type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: replyId, title } } }],
      } }] }],
    };
  }

  it('Início→Mensagem→Botões→(delay longo)→Mensagem→Fim: salvo via API, disparado por keyword, respeitando delays', async () => {
    const app = createApp(repo);

    // 1) Salva o fluxo COMO O BUILDER SALVA (POST /flows com nodes/edges/x/y).
    const created = await request(app)
      .post(`/api/instances/${inst.id}/flows`)
      .send({
        name: 'onboarding',
        trigger_keywords: ['começar'],
        active: true,
        nodes: [
          { id: 's', type: 'start', x: 10, y: 10 },
          { id: 'm1', type: 'message', data: { text: 'Bem-vindo, {{nome}}!' }, x: 200, y: 10 },
          { id: 'btn', type: 'buttons', data: { text: 'Quer saber mais?', buttons: [{ id: 'sim', title: 'Sim' }] }, x: 400, y: 10 },
          { id: 'd', type: 'delay', data: { seconds: 3600 }, x: 600, y: 10 },
          { id: 'm2', type: 'message', data: { text: 'Aqui está o material!' }, x: 800, y: 10 },
          { id: 'z', type: 'end', x: 1000, y: 10 },
        ],
        edges: [
          { source: 's', target: 'm1' },
          { source: 'm1', target: 'btn' },
          { source: 'btn', target: 'd', sourceHandle: 'sim' },
          { source: 'd', target: 'm2' },
          { source: 'm2', target: 'z' },
        ],
      })
      .expect(201);
    expect(created.body.warnings).toEqual([]); // fluxo bem formado

    const { provider, events } = makeRecordingProvider();
    const deps = { providerFor: () => provider };

    // 2) Keyword "começar" dispara: mensagem + botões, e espera.
    await processInboundPayload(repo, inboundText('começar', 'e1'), deps);
    expect(events.map((e) => e.kind)).toEqual(['text', 'buttons']);
    expect(events[0].payload).toBe('Bem-vindo, Ana!');

    // 3) Clique em "Sim" → entra no delay LONGO: nada enviado ainda, estado
    //    persistido apontando pro nó pós-delay (lição 1).
    await processInboundPayload(repo, inboundButtonReply('sim', 'Sim', 'e2'), deps);
    expect(events.length).toBe(2); // "Aqui está o material!" AINDA não saiu
    const flowId = created.body.flow.id;
    const active = await repo.flowExecutions.listActiveByFlow(flowId);
    expect(active.length).toBe(1);
    expect(active[0].current_node_id).toBe('m2'); // aresta já resolvida
    expect(active[0].next_step_at).not.toBeNull(); // retomada agendada

    // 4) Tempo passa; próximo tráfego de webhook retoma a execução.
    await repo.flowExecutions.updateIfStatus(active[0].id, 'running', {
      next_step_at: '2020-01-01T00:00:00.000Z',
    });
    const r = await processPendingExecutions(repo, inst.id, deps);
    expect(r.resumed).toBe(1);
    expect(events[2]).toMatchObject({ kind: 'text', payload: 'Aqui está o material!' });

    const done = await repo.flowExecutions.getById(active[0].id);
    expect(done?.status).toBe('completed'); // ponta a ponta ✔
  });
});
