import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import { syncTemplates, resolveTemplateLanguage, TemplateResolutionError } from '../src/domain/templates';
import { sendViaProvider } from '../src/domain/messaging';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

// Mock de fetch para a Graph API (envio + templates).
function makeFetch(responder: (url: string, init?: RequestInit) => { ok: boolean; status: number; json: unknown }) {
  const calls: { url: string; init?: RequestInit; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as RequestInit | undefined;
    calls.push({
      url: String(url),
      init: i,
      body: i?.body ? JSON.parse(i.body as string) : undefined,
    });
    const r = responder(String(url), i);
    return { ok: r.ok, status: r.status, json: async () => r.json } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let repo: Repo;
let instance: Instance;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  instance = await repo.instances.create({
    name: 'Loja',
    provider_type: 'meta',
    phone_number_id: '109999888777',
    waba_id: 'WABA1',
    token: 'TOKEN',
    verify_token: 'vt',
    active: true,
    connection_status: 'connected',
  });
});

const templatesResponse = {
  data: [
    { id: 'tpl_1', name: 'welcome', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [] },
    { id: 'tpl_2', name: 'welcome', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [] },
    { id: 'tpl_3', name: 'promo', language: 'es_ES', status: 'APPROVED', category: 'MARKETING', components: [] },
  ],
};

describe('syncTemplates', () => {
  it('busca da Meta e faz upsert com o idioma EXATO cadastrado', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    const r = await syncTemplates(repo, instance, { fetchImpl });
    expect(r.synced).toBe(3);

    const list = await repo.templates.list(instance.id);
    const langs = list.filter((t) => t.name === 'welcome').map((t) => t.language).sort();
    expect(langs).toEqual(['en_US', 'pt_BR']); // dois idiomas preservados
    const promo = list.find((t) => t.name === 'promo');
    expect(promo?.language).toBe('es_ES');
    expect(promo?.category).toBe('MARKETING');
    expect(promo?.wa_template_id).toBe('tpl_3');
  });

  it('re-sync não duplica (upsert por name+language)', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    await syncTemplates(repo, instance, { fetchImpl });
    await syncTemplates(repo, instance, { fetchImpl });
    expect((await repo.templates.list(instance.id)).length).toBe(3);
  });
});

describe('resolveTemplateLanguage — evita mismatch silencioso', () => {
  beforeEach(async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    await syncTemplates(repo, instance, { fetchImpl });
  });

  it('idioma único → resolve sem precisar informar', async () => {
    expect(await resolveTemplateLanguage(repo, instance, 'promo')).toBe('es_ES');
  });

  it('multi-idioma sem informar → erro (não escolhe pt_BR em silêncio)', async () => {
    await expect(resolveTemplateLanguage(repo, instance, 'welcome')).rejects.toBeInstanceOf(
      TemplateResolutionError,
    );
  });

  it('idioma informado que não existe na Meta → erro de mismatch', async () => {
    await expect(
      resolveTemplateLanguage(repo, instance, 'welcome', 'fr_FR'),
    ).rejects.toBeInstanceOf(TemplateResolutionError);
  });

  it('idioma informado e válido → usa exatamente esse', async () => {
    expect(await resolveTemplateLanguage(repo, instance, 'welcome', 'pt_BR')).toBe('pt_BR');
  });
});

describe('envio de template usa o idioma do registro sincronizado', () => {
  beforeEach(async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    await syncTemplates(repo, instance, { fetchImpl });
  });

  it('envia com language resolvido (es_ES) e monta o body correto na Graph API', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      json: { messages: [{ id: 'wamid.tpl' }] },
    }));
    const providerFor = () => new MetaCloudProvider({ fetchImpl });

    // Sem informar language: resolve 'es_ES' do registro sincronizado.
    const { message } = await sendViaProvider(
      repo,
      instance,
      { type: 'template', to: '5511999998888', template: { name: 'promo' } },
      { providerFor },
    );
    expect(message.status).toBe('sent');
    const tpl = calls[0].body!.template as Record<string, unknown>;
    expect(tpl.language).toEqual({ code: 'es_ES' }); // não pt_BR default
  });
});

describe('rotas de templates', () => {
  it('POST /sync sincroniza e GET lista', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    const app = createApp(repo, { templatesApi: { fetchImpl } });

    const sync = await request(app)
      .post(`/api/instances/${instance.id}/templates/sync`)
      .expect(200);
    expect(sync.body.synced).toBe(3);

    const list = await request(app).get(`/api/instances/${instance.id}/templates`).expect(200);
    expect(list.body.length).toBe(3);
  });

  it('POST /messages template multi-idioma sem language → 400 (mismatch evitado)', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, json: templatesResponse }));
    // Sincroniza direto no repo via app deps para a rota de sync.
    const app = createApp(repo, {
      templatesApi: { fetchImpl },
      providerFor: () => new MetaCloudProvider({ fetchImpl }),
    });
    await request(app).post(`/api/instances/${instance.id}/templates/sync`).expect(200);

    await request(app)
      .post(`/api/instances/${instance.id}/messages`)
      .send({ type: 'template', to: '5511999998888', template: { name: 'welcome' } })
      .expect(400);
  });
});
