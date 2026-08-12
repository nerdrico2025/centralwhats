import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import { sendViaProvider, SendFailedError } from '../src/domain/messaging';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

// --- Mock de fetch para a Graph API ---
interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
function makeFetch(
  responder: (call: CapturedCall) => { ok: boolean; status: number; json: unknown },
) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as RequestInit;
    const call: CapturedCall = {
      url: String(url),
      init: i,
      body: JSON.parse((i.body as string) ?? '{}'),
    };
    calls.push(call);
    const r = responder(call);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function okResponder(id = 'wamid.sent1') {
  return () => ({ ok: true, status: 200, json: { messages: [{ id }] } });
}

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

describe('MetaCloudProvider — payloads da Graph API (mock fetch)', () => {
  it('sendText monta URL, Bearer e body corretos', async () => {
    const { fetchImpl, calls } = makeFetch(okResponder());
    const p = new MetaCloudProvider({ fetchImpl, baseUrl: 'https://graph.test', apiVersion: 'v21.0' });
    const r = await p.sendText(instance, '+55 11 99999-8888', 'Olá');
    expect(r.waMessageId).toBe('wamid.sent1');
    expect(calls[0].url).toBe('https://graph.test/v21.0/109999888777/messages');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer TOKEN_ABC',
    );
    expect(calls[0].body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5511999998888', // normalizado
      type: 'text',
      text: { body: 'Olá' },
    });
  });

  it('sendTemplate usa o idioma EXATO recebido (nunca pt_BR fixo)', async () => {
    const { fetchImpl, calls } = makeFetch(okResponder());
    const p = new MetaCloudProvider({ fetchImpl });
    await p.sendTemplate(instance, '5511999998888', { name: 'welcome', language: 'en_US' }, {
      '1': 'Rafael',
    });
    expect(calls[0].body.type).toBe('template');
    const tpl = calls[0].body.template as Record<string, unknown>;
    expect(tpl.name).toBe('welcome');
    expect(tpl.language).toEqual({ code: 'en_US' }); // não assumiu pt_BR
    expect(tpl.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Rafael' }] },
    ]);
  });

  it('sendMedia: url→link, document carrega filename', async () => {
    const { fetchImpl, calls } = makeFetch(okResponder());
    const p = new MetaCloudProvider({ fetchImpl });
    await p.sendMedia(instance, '5511999998888', {
      kind: 'document',
      url: 'https://x/f.pdf',
      caption: 'doc',
      filename: 'f.pdf',
    });
    expect(calls[0].body.type).toBe('document');
    expect(calls[0].body.document).toMatchObject({
      link: 'https://x/f.pdf',
      caption: 'doc',
      filename: 'f.pdf',
    });
  });

  it('sendButtons / sendList / sendReaction / sendCtaUrl montam interativos corretos', async () => {
    const { fetchImpl, calls } = makeFetch(okResponder());
    const p = new MetaCloudProvider({ fetchImpl });

    await p.sendButtons(instance, '5511999998888', 'Escolha', [{ id: 'b1', title: 'Sim' }]);
    expect((calls[0].body.interactive as Record<string, unknown>).type).toBe('button');

    await p.sendList(instance, '5511999998888', 'Menu', 'Abrir', [
      { title: 'S1', rows: [{ id: 'r1', title: 'Op 1' }] },
    ]);
    expect((calls[1].body.interactive as Record<string, unknown>).type).toBe('list');

    await p.sendReaction(instance, '5511999998888', 'wamid.x', '👍');
    expect(calls[2].body).toMatchObject({ type: 'reaction', reaction: { emoji: '👍' } });

    await p.sendCtaUrl(instance, '5511999998888', 'Veja', 'Abrir site', 'https://x');
    expect((calls[3].body.interactive as Record<string, unknown>).type).toBe('cta_url');
  });

  it('erro da Meta vira MetaApiError com code/message', async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      status: 400,
      json: { error: { code: 131026, message: 'Message undeliverable' } },
    }));
    const p = new MetaCloudProvider({ fetchImpl });
    await expect(p.sendText(instance, '5511999998888', 'x')).rejects.toMatchObject({
      name: 'MetaApiError',
      code: '131026',
      httpStatus: 400,
    });
  });
});

describe('sendViaProvider — log em messages (sucesso E falha)', () => {
  it('sucesso grava messages(direction=out) com wa_message_id e status sent', async () => {
    const { fetchImpl } = makeFetch(okResponder('wamid.OUT'));
    const providerFor = () => new MetaCloudProvider({ fetchImpl });
    const { message, result } = await sendViaProvider(
      repo,
      instance,
      { type: 'text', to: '5511999998888', text: 'oi' },
      { providerFor },
    );
    expect(result.waMessageId).toBe('wamid.OUT');
    expect(message.direction).toBe('out');
    expect(message.status).toBe('sent');

    const saved = await repo.messages.getByWaMessageId(instance.id, 'wamid.OUT');
    expect(saved?.type).toBe('text');
  });

  it('falha da Meta grava messages(status=failed) com error_code/message e lança SendFailedError', async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      status: 400,
      json: { error: { code: 131026, message: 'Invalid recipient' } },
    }));
    const providerFor = () => new MetaCloudProvider({ fetchImpl });

    await expect(
      sendViaProvider(
        repo,
        instance,
        { type: 'text', to: '5511999998888', text: 'oi' },
        { providerFor },
      ),
    ).rejects.toBeInstanceOf(SendFailedError);

    // A falha FOI logada (nunca "só grava se deu certo").
    const msgs = await repo.messages.listByContact(instance.id, '5511999998888');
    const failed = msgs.find((m) => m.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.error_code).toBe('131026');
    expect(failed?.error_message).toBe('Invalid recipient');
    expect(failed?.direction).toBe('out');
  });
});

describe('POST /api/instances/:id/messages', () => {
  it('envia texto → 201 com wa_message_id e registra em messages', async () => {
    const { fetchImpl } = makeFetch(okResponder('wamid.ROUTE'));
    const app = createApp(repo, { providerFor: () => new MetaCloudProvider({ fetchImpl }) });

    const res = await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({ type: 'text', to: '5511999998888', text: 'Olá' })
      .expect(201);
    expect(res.body.wa_message_id).toBe('wamid.ROUTE');
    expect(res.body.status).toBe('sent');

    const saved = await repo.messages.getByWaMessageId(instance.id, 'wamid.ROUTE');
    expect(saved).not.toBeNull();
  });

  it('falha da Meta → 502 estruturado, com a falha já logada', async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      status: 400,
      json: { error: { code: 131056, message: 'rate limit' } },
    }));
    const app = createApp(repo, { providerFor: () => new MetaCloudProvider({ fetchImpl }) });

    const res = await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({ type: 'text', to: '5511999998888', text: 'x' })
      .expect(502);
    expect(res.body.details.code).toBe('131056');
    expect(res.body.details.logged_message_id).toBeDefined();
  });

  it('body inválido → 400; instância inexistente → 404', async () => {
    const app = createApp(repo);
    await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({ type: 'text', to: '5511999998888' }) // falta text
      .expect(400);
    await request(app)
      .post('/api/instances/nope/messages')
      .send({ type: 'text', to: '5511999998888', text: 'x' })
      .expect(404);
  });

  it('recurso não suportado pelo provider (template no Baileys) → 422', async () => {
    const baileys = await repo.instances.create({
    org_id: 'org_default',
      name: 'Baileys',
      provider_type: 'baileys',
      phone_number_id: '55110000000',
      waba_id: null,
      token: null,
      verify_token: null,
      active: true,
      connection_status: 'connected',
    });
    // Usa o dispatcher real (getProvider) → BaileysProvider, capabilities.template=false.
    const app = createApp(repo);
    await request(app)
      .post(`/api/instances/${baileys.id}/messages`)
      .send({ type: 'template', to: '5511999998888', template: { name: 'x', language: 'pt_BR' } })
      .expect(422);
  });
});
