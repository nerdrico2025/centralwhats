import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import { sendViaProvider, SendFailedError } from '../src/domain/messaging';
import { splitTemplateVars, buildHeaderComponent } from '../src/providers/templateComponents';
import { TemplateParamsError } from '../src/providers/errors';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

/**
 * Header dinâmico em template — mesma classe do bug do botão (132000): sem o
 * component `header` no payload, a Meta rejeita por contagem de parâmetros.
 */

interface CapturedCall {
  body: Record<string, unknown>;
}
function makeFetch() {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    const i = init as RequestInit;
    calls.push({ body: JSON.parse((i.body as string) ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.ok' }] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const HEADER_TEXT_DINAMICO = [
  { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
  { type: 'BODY', text: 'Olá {{1}}' },
];

/** Estrutura do template real em uso hoje: header ESTÁTICO (anti-regressão). */
const HEADER_ESTATICO = [
  { type: 'HEADER', format: 'TEXT', text: 'Cadastro confirmado' },
  { type: 'BODY', text: 'Olá {{1}}' },
];

const HEADER_IMAGEM = [
  { type: 'HEADER', format: 'IMAGE' },
  { type: 'BODY', text: 'Olá {{1}}' },
];

const HEADER_DOCUMENTO = [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Oi' }];

const SEM_HEADER = [{ type: 'BODY', text: 'Olá {{1}}' }];

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

describe('splitTemplateVars — chaves de header não vazam para o body', () => {
  it('separa header, headerMedia e afins do body e dos botões', () => {
    const r = splitTemplateVars({
      '1': 'Rafael',
      header: 'Pedido 123',
      headerMedia: 'https://x.com/a.jpg',
      headerMediaId: 'MID1',
      headerMediaType: 'image',
      headerMediaFilename: 'nota.pdf',
      button0: 'ABC',
    });
    expect(r.bodyVars).toEqual({ '1': 'Rafael' });
    expect(r.buttonVars).toEqual({ '0': 'ABC' });
    expect(r.headerVars).toEqual({
      text: 'Pedido 123',
      mediaLink: 'https://x.com/a.jpg',
      mediaId: 'MID1',
      mediaType: 'image',
      filename: 'nota.pdf',
    });
  });
});

describe('buildHeaderComponent', () => {
  it('template sem header → nenhum component (anti-regressão)', () => {
    expect(buildHeaderComponent(SEM_HEADER, {}, 'welcome')).toEqual([]);
  });

  it('header estático → nenhum component (anti-regressão do template atual)', () => {
    expect(buildHeaderComponent(HEADER_ESTATICO, {}, 'vaga')).toEqual([]);
  });

  it('header TEXT com variável informada → component correto', () => {
    expect(buildHeaderComponent(HEADER_TEXT_DINAMICO, { text: 'A-1234' }, 'pedido')).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'A-1234' }] },
    ]);
  });

  it('header TEXT com variável faltando → TemplateParamsError', () => {
    expect(() => buildHeaderComponent(HEADER_TEXT_DINAMICO, {}, 'pedido')).toThrow(
      TemplateParamsError,
    );
  });

  it('header IMAGE com link → component com media object', () => {
    expect(
      buildHeaderComponent(HEADER_IMAGEM, { mediaLink: 'https://x.com/a.jpg' }, 'promo'),
    ).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.com/a.jpg' } }] },
    ]);
  });

  it('header IMAGE aceita id de mídia já subida à Meta', () => {
    expect(buildHeaderComponent(HEADER_IMAGEM, { mediaId: 'MID123' }, 'promo')).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'MID123' } }] },
    ]);
  });

  it('header DOCUMENT propaga filename', () => {
    expect(
      buildHeaderComponent(
        HEADER_DOCUMENTO,
        { mediaLink: 'https://x.com/n.pdf', filename: 'nota.pdf' },
        'nota',
      ),
    ).toEqual([
      {
        type: 'header',
        parameters: [
          { type: 'document', document: { link: 'https://x.com/n.pdf', filename: 'nota.pdf' } },
        ],
      },
    ]);
  });

  it('header de mídia sem link nem id → TemplateParamsError', () => {
    expect(() => buildHeaderComponent(HEADER_IMAGEM, {}, 'promo')).toThrow(TemplateParamsError);
  });

  it('link E id ao mesmo tempo → erro (ambíguo, não chuta)', () => {
    expect(() =>
      buildHeaderComponent(HEADER_IMAGEM, { mediaLink: 'https://x/a.jpg', mediaId: 'M1' }, 'promo'),
    ).toThrow(TemplateParamsError);
  });

  it('chave errada para o tipo de header → erro acionável', () => {
    expect(() => buildHeaderComponent(HEADER_IMAGEM, { text: 'oi' }, 'promo')).toThrow(
      /headerMedia/,
    );
    expect(() =>
      buildHeaderComponent(HEADER_TEXT_DINAMICO, { mediaLink: 'https://x/a.jpg' }, 'pedido'),
    ).toThrow(/TEXT/);
  });

  it('variável de header em template sem header → erro', () => {
    expect(() => buildHeaderComponent(SEM_HEADER, { text: 'oi' }, 'welcome')).toThrow(
      TemplateParamsError,
    );
  });

  it('não sincronizado: confia no texto informado', () => {
    expect(buildHeaderComponent(null, { text: 'A-1' }, 'novo')).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'A-1' }] },
    ]);
  });

  it('não sincronizado + mídia sem headerMediaType → erro claro', () => {
    expect(() => buildHeaderComponent(null, { mediaLink: 'https://x/a.jpg' }, 'novo')).toThrow(
      /headerMediaType/,
    );
  });

  it('não sincronizado + headerMediaType informado → monta', () => {
    expect(
      buildHeaderComponent(null, { mediaLink: 'https://x/a.jpg', mediaType: 'video' }, 'novo'),
    ).toEqual([
      { type: 'header', parameters: [{ type: 'video', video: { link: 'https://x/a.jpg' } }] },
    ]);
  });
});

describe('MetaCloudProvider.sendTemplate — header + body + botão no mesmo payload', () => {
  it('ordem e conteúdo dos components', async () => {
    const { fetchImpl, calls } = makeFetch();
    const p = new MetaCloudProvider({ fetchImpl });
    const components = [
      ...HEADER_TEXT_DINAMICO,
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.com/{{1}}' }] },
    ];
    await p.sendTemplate(
      instance,
      '5511999998888',
      { name: 'pedido', language: 'pt_BR', components },
      { '1': 'Rafael', header: 'A-1234', button0: 'sufixo' },
    );
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'A-1234' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Rafael' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'sufixo' }] },
    ]);
  });

  it('template de header estático segue idêntico ao anterior — sem regressão', async () => {
    const { fetchImpl, calls } = makeFetch();
    const p = new MetaCloudProvider({ fetchImpl });
    await p.sendTemplate(
      instance,
      '5511999998888',
      { name: 'vaga', language: 'pt_BR', components: HEADER_ESTATICO },
      { '1': 'Rafael' },
    );
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Rafael' }] },
    ]);
  });
});

describe('sendViaProvider — falha de header é logada como qualquer outro envio', () => {
  async function syncTemplate(components: unknown) {
    await repo.templates.upsert({
      instance_id: instance.id,
      name: 'pedido_status',
      category: 'UTILITY',
      language: 'pt_BR',
      status: 'APPROVED',
      components,
      wa_template_id: 'T1',
    });
  }

  it('header faltando → 400, zero chamadas à Meta, falha gravada em messages', async () => {
    await syncTemplate(HEADER_TEXT_DINAMICO);
    const { fetchImpl, calls } = makeFetch();
    const app = createApp(repo, { providerFor: () => new MetaCloudProvider({ fetchImpl }) });

    const res = await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({
        type: 'template',
        to: '5511999998888',
        template: { name: 'pedido_status' },
        vars: { '1': 'Rafael' }, // sem "header"
      })
      .expect(400);

    expect(res.body.error).toMatch(/"header"/);
    expect(calls).toHaveLength(0);

    const msgs = await repo.messages.listByContact(instance.id, '5511999998888', { limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe('failed');
    expect(msgs[0].error_code).toBe('TEMPLATE_PARAMS');
    expect(msgs[0].direction).toBe('out');
  });

  it('header de mídia faltando → SendFailedError (campanha registra, não retenta)', async () => {
    await syncTemplate(HEADER_IMAGEM);
    const { fetchImpl } = makeFetch();
    await expect(
      sendViaProvider(
        repo,
        instance,
        {
          type: 'template',
          to: '5511999998888',
          template: { name: 'pedido_status' },
          vars: { '1': 'Rafael' },
        },
        { providerFor: () => new MetaCloudProvider({ fetchImpl }) },
      ),
    ).rejects.toBeInstanceOf(SendFailedError);
  });

  it('header dinâmico preenchido → envio normal, sem error_code', async () => {
    await syncTemplate(HEADER_TEXT_DINAMICO);
    const { fetchImpl, calls } = makeFetch();
    const app = createApp(repo, { providerFor: () => new MetaCloudProvider({ fetchImpl }) });

    await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({
        type: 'template',
        to: '5511999998888',
        template: { name: 'pedido_status' },
        vars: { '1': 'Rafael', header: 'A-1234' },
      })
      .expect(201);

    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.components).toContainEqual({
      type: 'header',
      parameters: [{ type: 'text', text: 'A-1234' }],
    });
    const msgs = await repo.messages.listByContact(instance.id, '5511999998888', { limit: 10 });
    expect(msgs[0].status).toBe('sent');
    expect(msgs[0].error_code).toBeNull();
  });
});
