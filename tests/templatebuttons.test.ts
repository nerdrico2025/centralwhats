import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import { sendViaProvider, SendFailedError } from '../src/domain/messaging';
import { splitTemplateVars, buildButtonComponents } from '../src/providers/templateComponents';
import { TemplateParamsError } from '../src/providers/errors';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

/**
 * Botão de URL dinâmica em template (bug do 132000): a Graph API exige um
 * component `button` por botão com variável. Só body não basta.
 */

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}
function makeFetch() {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as RequestInit;
    calls.push({ url: String(url), body: JSON.parse((i.body as string) ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.ok' }] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Estrutura REAL do template aprovado nesta WABA (sync da Meta). */
const COMPONENTS_COM_BOTAO_DINAMICO = [
  { type: 'HEADER', format: 'TEXT', text: 'Cadastro confirmado' },
  { type: 'BODY', text: 'Olá {{1}}, vaga de {{2}}. Grupo: {{3}}' },
  { type: 'FOOTER', text: 'Vendedor Mestre' },
  {
    type: 'BUTTONS',
    buttons: [{ type: 'URL', text: 'Entrar no grupo', url: 'http://business.facebook.com/{{1}}' }],
  },
];

const COMPONENTS_SO_BODY = [{ type: 'BODY', text: 'Olá {{1}}' }];

const COMPONENTS_BOTOES_ESTATICOS = [
  { type: 'BODY', text: 'Olá {{1}}' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Parar promoções' },
      { type: 'URL', text: 'Site', url: 'https://exemplo.com/fixo' },
    ],
  },
];

let repo: Repo;
let instance: Instance;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  instance = await repo.instances.create({
    org_id: 'org_default',
    name: 'Loja',
    provider_type: 'meta',
    phone_number_id: '109999888777',
    waba_id: 'WABA1',
    token: 'TOKEN_ABC',
    verify_token: 'vt',
    active: true,
    connection_status: 'connected',
  });
});

describe('splitTemplateVars — separa vars de body das de botão', () => {
  it('chaves numéricas viram body; button<N> viram botão', () => {
    const r = splitTemplateVars({ '1': 'Rafael', '2': 'SDR', button0: 'ABC123' });
    expect(r.bodyVars).toEqual({ '1': 'Rafael', '2': 'SDR' });
    expect(r.buttonVars).toEqual({ '0': 'ABC123' });
  });

  it('sem vars não quebra', () => {
    expect(splitTemplateVars(undefined)).toEqual({
      bodyVars: {},
      buttonVars: {},
      headerVars: {},
    });
  });
});

describe('buildButtonComponents — só gera component quando há variável de fato', () => {
  it('template só com body → nenhum component de botão', () => {
    expect(buildButtonComponents(COMPONENTS_SO_BODY, {}, 'welcome')).toEqual([]);
  });

  it('quick_reply e URL estática → nenhum component de botão', () => {
    expect(buildButtonComponents(COMPONENTS_BOTOES_ESTATICOS, {}, 'promo')).toEqual([]);
  });

  it('botão de URL dinâmica → component no formato exato da Graph API', () => {
    const out = buildButtonComponents(COMPONENTS_COM_BOTAO_DINAMICO, { '0': 'KEQaSk' }, 'vaga');
    expect(out).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0', // index é STRING na Graph API
        parameters: [{ type: 'text', text: 'KEQaSk' }],
      },
    ]);
  });

  it('múltiplos botões dinâmicos → um component por botão, índice = posição', () => {
    const components = [
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Não quero' },
          { type: 'URL', text: 'Grupo', url: 'https://a.com/{{1}}' },
          { type: 'URL', text: 'Contrato', url: 'https://b.com/{{1}}' },
        ],
      },
    ];
    const out = buildButtonComponents(components, { '1': 'gA', '2': 'cB' }, 'multi');
    expect(out.map((c) => c.index)).toEqual(['1', '2']);
    expect(out[1].parameters).toEqual([{ type: 'text', text: 'cB' }]);
  });

  it('variável de botão faltando → erro claro, nunca payload malformado', () => {
    expect(() => buildButtonComponents(COMPONENTS_COM_BOTAO_DINAMICO, {}, 'vaga')).toThrow(
      TemplateParamsError,
    );
  });

  it('variável de botão em índice inexistente → erro claro', () => {
    expect(() =>
      buildButtonComponents(COMPONENTS_BOTOES_ESTATICOS, { '0': 'x' }, 'promo'),
    ).toThrow(TemplateParamsError);
  });

  it('template não sincronizado (sem components) → confia no que foi informado', () => {
    expect(buildButtonComponents(null, { '0': 'ABC' }, 'novo')).toEqual([
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ABC' }] },
    ]);
  });
});

describe('MetaCloudProvider.sendTemplate — payload completo', () => {
  it('body + botão dinâmico no mesmo envio', async () => {
    const { fetchImpl, calls } = makeFetch();
    const p = new MetaCloudProvider({ fetchImpl });
    await p.sendTemplate(
      instance,
      '5511999998888',
      { name: 'vaga', language: 'pt_BR', components: COMPONENTS_COM_BOTAO_DINAMICO },
      { '1': 'Rafael', '2': 'SDR', '3': 'link', button0: 'KEQaSk' },
    );
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Rafael' },
          { type: 'text', text: 'SDR' },
          { type: 'text', text: 'link' },
        ],
      },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'KEQaSk' }] },
    ]);
  });

  it('caminho antigo (só body) segue idêntico — sem regressão', async () => {
    const { fetchImpl, calls } = makeFetch();
    const p = new MetaCloudProvider({ fetchImpl });
    await p.sendTemplate(
      instance,
      '5511999998888',
      { name: 'welcome', language: 'en_US', components: COMPONENTS_SO_BODY },
      { '1': 'Rafael' },
    );
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Rafael' }] },
    ]);
  });
});

describe('sendViaProvider — components vêm do template sincronizado', () => {
  async function syncTemplateComBotao() {
    await repo.templates.upsert({
      instance_id: instance.id,
      name: 'confirmacao_cadastro_vaga_vm',
      category: 'UTILITY',
      language: 'pt_BR',
      status: 'APPROVED',
      components: COMPONENTS_COM_BOTAO_DINAMICO,
      wa_template_id: 'T1',
    });
  }

  it('monta o botão a partir dos components salvos, sem o chamador informá-los', async () => {
    await syncTemplateComBotao();
    const { fetchImpl, calls } = makeFetch();
    const app = createApp(repo, {
      providerFor: () => new MetaCloudProvider({ fetchImpl }),
    });

    const res = await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({
        type: 'template',
        to: '5511999998888',
        template: { name: 'confirmacao_cadastro_vaga_vm' },
        vars: { '1': 'Rafael', '2': 'SDR', '3': 'link', button0: 'KEQaSk' },
      })
      .expect(201);

    expect(res.body.status).toBe('sent');
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.language).toEqual({ code: 'pt_BR' });
    expect(tpl.components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'KEQaSk' }],
    });
  });

  it('variável de botão faltando → 400, e a FALHA é logada em messages', async () => {
    await syncTemplateComBotao();
    const { fetchImpl, calls } = makeFetch();
    const app = createApp(repo, {
      providerFor: () => new MetaCloudProvider({ fetchImpl }),
    });

    const res = await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({
        type: 'template',
        to: '5511999998888',
        template: { name: 'confirmacao_cadastro_vaga_vm' },
        vars: { '1': 'Rafael', '2': 'SDR', '3': 'link' }, // sem button0
      })
      .expect(400);

    expect(res.body.error).toMatch(/button0/);
    // Nunca chegou a tocar na Graph API com payload malformado.
    expect(calls).toHaveLength(0);
    // Mas o envio foi logado como falha (CLAUDE.md: logue TODO envio).
    const msgs = await repo.messages.listByContact(instance.id, '5511999998888', { limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe('failed');
    expect(msgs[0].error_code).toBe('TEMPLATE_PARAMS');
    expect(msgs[0].direction).toBe('out');
  });

  it('erro de parâmetro chega como SendFailedError (campanha registra e não retenta)', async () => {
    await syncTemplateComBotao();
    const { fetchImpl } = makeFetch();
    await expect(
      sendViaProvider(
        repo,
        instance,
        {
          type: 'template',
          to: '5511999998888',
          template: { name: 'confirmacao_cadastro_vaga_vm' },
          vars: { '1': 'Rafael' },
        },
        { providerFor: () => new MetaCloudProvider({ fetchImpl }) },
      ),
    ).rejects.toBeInstanceOf(SendFailedError);
  });
});
