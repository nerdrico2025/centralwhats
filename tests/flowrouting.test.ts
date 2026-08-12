import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { runExecution, type FlowDefinition } from '../src/domain/flowEngine';
import { handleFlowInbound } from '../src/domain/flows';
import { processInboundPayload } from '../src/domain/webhook';
import type { Repo } from '../src/repo';
import type { Instance, Flow } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

// Fluxo: Início → Botões (sim→TagVip→MsgSim→Fim | nao→MsgNao→Fim)
const DEF: FlowDefinition = {
  nodes: [
    { id: 'n1', type: 'start' },
    {
      id: 'n2',
      type: 'buttons',
      data: {
        text: 'Quer receber ofertas, {{nome}}?',
        buttons: [
          { id: 'sim', title: 'Sim' },
          { id: 'nao', title: 'Não' },
        ],
      },
    },
    { id: 'n3', type: 'tag', data: { name: 'vip' } },
    { id: 'n4', type: 'message', data: { text: 'Perfeito, {{nome}}! Você está na lista.' } },
    { id: 'n5', type: 'message', data: { text: 'Sem problemas.' } },
    { id: 'n6', type: 'end' },
  ],
  edges: [
    { source: 'n1', target: 'n2' },
    { source: 'n2', target: 'n3', sourceHandle: 'sim' },
    { source: 'n2', target: 'n5', sourceHandle: 'nao' },
    { source: 'n3', target: 'n4' },
    { source: 'n4', target: 'n6' },
    { source: 'n5', target: 'n6' },
  ],
};

const CTX = { contactPhone: '5511999998888', contactName: 'Ana' };

function makeRecordingProvider() {
  const events: { kind: string; payload: unknown }[] = [];
  const ok = (): Promise<SendResult> =>
    Promise.resolve({ waMessageId: 'wamid.' + (events.length + 1), status: 'sent' as const });
  const provider: Provider = {
    type: 'meta',
    capabilities: { text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true },
    sendText: (_i, to, text) => { events.push({ kind: 'text', payload: text }); return ok(); },
    sendMedia: (_i, _to, media) => { events.push({ kind: 'media', payload: media }); return ok(); },
    sendButtons: (_i, _to, body, buttons) => { events.push({ kind: 'buttons', payload: { body, buttons } }); return ok(); },
    sendList: (_i, _to, body, buttonText, sections) => { events.push({ kind: 'list', payload: { body, buttonText, sections } }); return ok(); },
    sendTemplate: () => ok(),
    sendReaction: () => ok(),
    sendCtaUrl: () => ok(),
  };
  return { provider, events };
}

describe('engine — nós interativos (puro)', () => {
  it('Botões: emite send_buttons e fica em waiting_input no nó', async () => {
    const r = await runExecution(DEF, { current_node_id: null, status: 'running', variables: {} }, { type: 'start' }, CTX);
    expect(r.actions).toEqual([
      {
        kind: 'send_buttons',
        to: CTX.contactPhone,
        body: 'Quer receber ofertas, Ana?',
        buttons: [
          { id: 'sim', title: 'Sim' },
          { id: 'nao', title: 'Não' },
        ],
      },
    ]);
    expect(r.patch.status).toBe('waiting_input');
    expect(r.patch.current_node_id).toBe('n2');
  });

  it('input "sim" segue a aresta do botão: aplica tag e envia a mensagem certa', async () => {
    const waiting = { current_node_id: 'n2', status: 'waiting_input' as const, variables: {} };
    const r = await runExecution(DEF, waiting, { type: 'input', input: { id: 'sim', text: null } }, CTX);
    expect(r.actions).toEqual([
      { kind: 'apply_tag', contactPhone: CTX.contactPhone, tagName: 'vip' },
      { kind: 'send_text', to: CTX.contactPhone, text: 'Perfeito, Ana! Você está na lista.' },
    ]);
    expect(r.patch.status).toBe('completed');
  });

  it('input "nao" segue a OUTRA aresta (sem tag)', async () => {
    const waiting = { current_node_id: 'n2', status: 'waiting_input' as const, variables: {} };
    const r = await runExecution(DEF, waiting, { type: 'input', input: { id: 'nao', text: null } }, CTX);
    expect(r.actions).toEqual([{ kind: 'send_text', to: CTX.contactPhone, text: 'Sem problemas.' }]);
    expect(r.patch.status).toBe('completed');
  });

  it('texto digitado que casa com o TÍTULO do botão também roteia', async () => {
    const waiting = { current_node_id: 'n2', status: 'waiting_input' as const, variables: {} };
    const r = await runExecution(DEF, waiting, { type: 'input', input: { id: null, text: 'não' } }, CTX);
    expect(r.patch.status).toBe('completed');
    expect(r.actions[0]).toMatchObject({ kind: 'send_text', text: 'Sem problemas.' });
  });

  it('resposta que não casa com nenhuma opção: continua aguardando', async () => {
    const waiting = { current_node_id: 'n2', status: 'waiting_input' as const, variables: {} };
    const r = await runExecution(DEF, waiting, { type: 'input', input: { id: null, text: 'talvez' } }, CTX);
    expect(r.patch.status).toBe('waiting_input');
    expect(r.patch.current_node_id).toBe('n2');
    expect(r.actions).toEqual([]);
  });

  it('Lista: cada opção roteia pela própria aresta', async () => {
    const listDef: FlowDefinition = {
      nodes: [
        { id: 'a', type: 'start' },
        {
          id: 'b',
          type: 'list',
          data: {
            text: 'Escolha um plano',
            buttonText: 'Ver planos',
            sections: [{ title: 'Planos', rows: [
              { id: 'basic', title: 'Básico' },
              { id: 'pro', title: 'Pro' },
            ] }],
          },
        },
        { id: 'c', type: 'message', data: { text: 'Básico escolhido' } },
        { id: 'd', type: 'message', data: { text: 'Pro escolhido' } },
        { id: 'e', type: 'end' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c', sourceHandle: 'basic' },
        { source: 'b', target: 'd', sourceHandle: 'pro' },
        { source: 'c', target: 'e' },
        { source: 'd', target: 'e' },
      ],
    };
    const started = await runExecution(listDef, { current_node_id: null, status: 'running', variables: {} }, { type: 'start' }, CTX);
    expect(started.actions[0].kind).toBe('send_list');
    expect(started.patch.status).toBe('waiting_input');

    const routed = await runExecution(
      listDef,
      { current_node_id: 'b', status: 'waiting_input', variables: {} },
      { type: 'input', input: { id: 'pro', text: null } },
      CTX,
    );
    expect(routed.actions).toEqual([{ kind: 'send_text', to: CTX.contactPhone, text: 'Pro escolhido' }]);
  });

  it('Mídia: emite send_media e segue adiante', async () => {
    const mediaDef: FlowDefinition = {
      nodes: [
        { id: 'a', type: 'start' },
        { id: 'b', type: 'media', data: { kind: 'image', url: 'https://x/img.png', caption: 'Oi {{nome}}' } },
        { id: 'c', type: 'end' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    const r = await runExecution(mediaDef, { current_node_id: null, status: 'running', variables: {} }, { type: 'start' }, CTX);
    expect(r.actions).toEqual([
      { kind: 'send_media', to: CTX.contactPhone, media: { kind: 'image', url: 'https://x/img.png', caption: 'Oi Ana', mediaId: undefined, filename: undefined } },
    ]);
    expect(r.patch.status).toBe('completed');
  });
});

describe('roteamento ponta a ponta (webhook → fluxo)', () => {
  let repo: Repo;
  let inst: Instance;
  let flow: Flow;
  const PNID = '109999888777';
  const PHONE = '5511999998888';

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

  beforeEach(async () => {
    repo = createSqliteAdapter({ path: ':memory:' });
    await repo.migrate();
    inst = await repo.instances.create({
    org_id: 'org_default',
      name: 'Loja', provider_type: 'meta', phone_number_id: PNID, waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    flow = await repo.flows.create({
      instance_id: inst.id, name: 'ofertas', trigger_keywords: ['oi'],
      nodes: DEF.nodes, edges: DEF.edges, active: true,
    });
  });

  it('keyword inicia o fluxo; clique no botão roteia; tag reflete no contato', async () => {
    const { provider, events } = makeRecordingProvider();
    const deps = { providerFor: () => provider };

    // 1) "oi" → dispara o fluxo → envia botões e espera.
    await processInboundPayload(repo, inboundText('oi', 'w1'), deps);
    expect(events[0].kind).toBe('buttons');
    const waiting = await repo.flowExecutions.findWaitingByContact(inst.id, PHONE);
    expect(waiting?.current_node_id).toBe('n2');

    // 2) Clique em "Sim" → tag vip + mensagem + completed.
    await processInboundPayload(repo, inboundButtonReply('sim', 'Sim', 'w2'), deps);
    expect(events[1]).toMatchObject({ kind: 'text', payload: 'Perfeito, Ana! Você está na lista.' });

    const done = await repo.flowExecutions.getById(waiting!.id);
    expect(done?.status).toBe('completed');

    // Tag reflete no contato.
    const contact = await repo.contacts.getByPhone(inst.id, PHONE);
    const tags = await repo.tags.listForContact(inst.id, contact!.id);
    expect(tags.map((t) => t.name)).toEqual(['vip']);
  });

  it('LIÇÃO 5: keyword repetida não duplica NESTE fluxo, mas execução presa em OUTRO fluxo não bloqueia', async () => {
    const { provider, events } = makeRecordingProvider();
    const deps = { providerFor: () => provider };

    // Execução presa (running) num OUTRO fluxo antigo do mesmo contato.
    const oldFlow = await repo.flows.create({
      instance_id: inst.id, name: 'antigo', trigger_keywords: ['antigo'],
      nodes: DEF.nodes, edges: DEF.edges, active: true,
    });
    await repo.flowExecutions.create({
      flow_id: oldFlow.id, instance_id: inst.id, contact_phone: PHONE,
      current_node_id: 'n4', status: 'running', variables: {}, next_step_at: null,
    });

    // "oi" inicia o fluxo NOVO normalmente (a trava é por fluxo+contato).
    const r = await handleFlowInbound(repo, inst, PHONE, { text: 'oi', replyId: null }, deps);
    expect(r.started).toBe(true);
    expect(events[0].kind).toBe('buttons');

    // Segundo "oi" NÃO duplica (já há execução ativa DESTE fluxo).
    // (o contato está waiting_input, então o input é roteado, não gatilhado —
    //  "oi" não casa com nenhum botão → continua aguardando, sem nova execução)
    const before = (await repo.flowExecutions.findActiveByFlowAndContact(flow.id, PHONE))!.id;
    await handleFlowInbound(repo, inst, PHONE, { text: 'oi', replyId: null }, deps);
    const after = await repo.flowExecutions.findActiveByFlowAndContact(flow.id, PHONE);
    expect(after!.id).toBe(before);
    expect(events.length).toBe(1); // nenhum reenvio
  });

  it('fluxo inativo não dispara por keyword', async () => {
    await repo.flows.update(inst.id, flow.id, { active: false });
    const { provider, events } = makeRecordingProvider();
    const r = await handleFlowInbound(repo, inst, PHONE, { text: 'oi', replyId: null }, {
      providerFor: () => provider,
    });
    expect(r.started).toBe(false);
    expect(events.length).toBe(0);
  });
});
