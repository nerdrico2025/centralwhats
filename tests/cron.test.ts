import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { startCampaign, processAllPendingCampaigns } from '../src/domain/dispatch';
import { resetEnvCache } from '../src/config';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

/**
 * P3.2 — cron de disparo autônomo.
 *
 * O que estes testes protegem: a rota dispara ENVIO REAL de mensagem. Se o
 * segredo falhar, qualquer um na internet dispara campanha alheia. E se o cron
 * duplicar o trabalho de um tick de webhook/UI, o contato recebe a mensagem
 * duas vezes — o pecado capital do disparo em massa.
 */

const SECRET = 'segredo-de-teste-do-cron';

let repo: Repo;
let app: ReturnType<typeof createApp>;
let savedSecret: string | undefined;

/** Provider fake que sempre aceita e registra para quem enviou. */
function makeProvider() {
  const calls: string[] = [];
  const provider: Provider = {
    type: 'meta',
    capabilities: {
      text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true,
    },
    async sendTemplate(_i, to): Promise<SendResult> {
      calls.push(to);
      return { waMessageId: 'wamid.' + to + '.' + calls.length, status: 'sent' };
    },
    sendText: () => { throw new Error('não usado'); },
    sendMedia: () => { throw new Error('não usado'); },
    sendButtons: () => { throw new Error('não usado'); },
    sendList: () => { throw new Error('não usado'); },
    sendReaction: () => { throw new Error('não usado'); },
    sendCtaUrl: () => { throw new Error('não usado'); },
  };
  return { provider, calls };
}

/** Instância + template + campanha 'running' com N contatos na fila. */
async function seedRunningCampaign(
  nome: string,
  phoneNumberId: string,
  n: number,
  deps: { providerFor: () => Provider },
  ddd = '11',
): Promise<{ instance: Instance; campaignId: string }> {
  const instance = await repo.instances.create({
    name: nome, provider_type: 'meta', phone_number_id: phoneNumberId, waba_id: null,
    token: 't', verify_token: 'v', active: true, connection_status: 'connected',
  });
  const tpl = await repo.templates.upsert({
    instance_id: instance.id, name: 'promo', category: 'MARKETING', language: 'pt_BR',
    status: 'APPROVED', components: [], wa_template_id: 'tpl-' + phoneNumberId,
  });
  const list = await repo.lists.create({ instance_id: instance.id, name: 'L' });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await repo.contacts.upsert({
      instance_id: instance.id,
      // DDD distinto por instância: deixa óbvio nas asserções se algo cruzou.
      phone: '55' + ddd + String(900000000 + i),
      name: 'C' + i,
      last_seen: null,
    });
    ids.push(c.id);
  }
  await repo.lists.addContacts(instance.id, list.id, ids);
  const campaign = await repo.campaigns.create({
    instance_id: instance.id, name: 'Camp ' + nome, template_id: tpl.id,
    total_recipients: 0, interval_ms: 0, status: 'draft',
    config: { list_ids: [list.id], variables: { '1': 'name' } },
  });
  await startCampaign(repo, instance, campaign.id, deps);
  return { instance, campaignId: campaign.id };
}

beforeEach(async () => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  resetEnvCache();
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
  resetEnvCache();
});

describe('Cron — proteção do endpoint', () => {
  beforeEach(() => {
    app = createApp(repo);
  });

  it('sem header Authorization → 401 e NADA é processado', async () => {
    const { provider, calls } = makeProvider();
    app = createApp(repo, { providerFor: () => provider });
    await seedRunningCampaign('A', '10000000001', 3, { providerFor: () => provider });
    calls.length = 0;

    await request(app).post('/api/cron/tick-campaigns').expect(401);
    expect(calls).toEqual([]); // nenhum envio disparado
  });

  it('segredo errado → 401', async () => {
    await request(app)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer segredo-errado')
      .expect(401);
  });

  it('segredo certo mas esquema errado (Basic) → 401', async () => {
    await request(app)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Basic ' + SECRET)
      .expect(401);
  });

  it('prefixo correto do segredo não passa (comparação é do valor inteiro)', async () => {
    await request(app)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer ' + SECRET.slice(0, -1))
      .expect(401);
  });

  it('segredo certo → 200', async () => {
    const res = await request(app)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer ' + SECRET)
      .expect(200);
    expect(res.body).toMatchObject({ instances: 0, campaigns: 0, processed: 0 });
  });

  it('GET também é aceito — é o método que o agendador da Vercel usa', async () => {
    await request(app)
      .get('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer ' + SECRET)
      .expect(200);
    // ...mas continua protegido no GET.
    await request(app).get('/api/cron/tick-campaigns').expect(401);
  });

  it('sem CRON_SECRET configurado → 503, rota FECHADA (nunca aberta)', async () => {
    delete process.env.CRON_SECRET;
    resetEnvCache();
    const { provider, calls } = makeProvider();
    const appSemSecret = createApp(repo, { providerFor: () => provider });
    await seedRunningCampaign('A', '10000000002', 3, { providerFor: () => provider });
    calls.length = 0;

    await request(appSemSecret).post('/api/cron/tick-campaigns').expect(503);
    // Sem segredo configurado, uma chamada anônima também não passa.
    await request(appSemSecret)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer qualquer-coisa')
      .expect(503);
    expect(calls).toEqual([]);
  });

  it('a rota NÃO exige login (não é usuário logado que chama)', async () => {
    // Passa pelo secret sem nenhum JWT: prova que está montada antes do
    // middleware de autenticação.
    await request(app)
      .post('/api/cron/tick-campaigns')
      .set('Authorization', 'Bearer ' + SECRET)
      .expect(200);
  });
});

describe('Cron — varredura multi-instância', () => {
  it('avança campanhas de VÁRIAS instâncias numa invocação, sem cruzar dados', async () => {
    const { provider, calls } = makeProvider();
    const deps = { providerFor: () => provider };
    const a = await seedRunningCampaign('A', '10000000011', 4, deps, '11');
    const b = await seedRunningCampaign('B', '10000000022', 3, deps, '21');
    calls.length = 0;

    const res = await processAllPendingCampaigns(repo, deps);

    expect(res.instances).toBe(2);
    expect(res.campaigns).toBe(2);
    expect(res.processed).toBe(7);

    // Cada campanha só tocou nos SEUS destinatários — nada cruzou instância.
    const sendsA = await repo.campaigns.listSends(a.campaignId);
    const sendsB = await repo.campaigns.listSends(b.campaignId);
    expect(sendsA.length).toBe(4);
    expect(sendsB.length).toBe(3);
    expect(sendsA.every((s) => s.contact_phone.startsWith('5511'))).toBe(true);
    expect(sendsB.every((s) => s.contact_phone.startsWith('5521'))).toBe(true);
    expect(sendsA.every((s) => s.status === 'sent')).toBe(true);
    expect(sendsB.every((s) => s.status === 'sent')).toBe(true);

    // Ambas concluídas: o cron levou até o fim sem UI e sem webhook.
    expect((await repo.campaigns.getById(a.instance.id, a.campaignId))!.status).toBe('completed');
    expect((await repo.campaigns.getById(b.instance.id, b.campaignId))!.status).toBe('completed');
  });

  it('campanha pausada não é tocada pelo cron', async () => {
    const { provider, calls } = makeProvider();
    const deps = { providerFor: () => provider };
    const a = await seedRunningCampaign('A', '10000000033', 3, deps);
    await repo.campaigns.update(a.instance.id, a.campaignId, { status: 'paused' });
    calls.length = 0;

    const res = await processAllPendingCampaigns(repo, deps);
    expect(res.campaigns).toBe(0);
    expect(calls).toEqual([]);
  });

  it('falha em uma instância não impede a varredura das outras', async () => {
    const { provider, calls } = makeProvider();
    const deps = { providerFor: () => provider };
    const a = await seedRunningCampaign('A', '10000000044', 2, deps);
    const b = await seedRunningCampaign('B', '10000000055', 2, deps);
    // Template sumiu só na instância A → o tick dela lança DispatchError.
    await repo.campaigns.update(a.instance.id, a.campaignId, { template_id: 'inexistente' });
    calls.length = 0;

    const res = await processAllPendingCampaigns(repo, deps);

    // B foi processada mesmo com A quebrando.
    expect(res.processed).toBe(2);
    expect((await repo.campaigns.getById(b.instance.id, b.campaignId))!.status).toBe('completed');
    // E A não sumiu em silêncio: continua running, com a fila intacta p/ diagnóstico.
    const sendsA = await repo.campaigns.listSends(a.campaignId);
    expect(sendsA.every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('Cron — não duplica envio (reaproveita o claim atômico)', () => {
  it('cron concorrente com tick de webhook/UI: cada contato recebe UMA vez', async () => {
    const { provider, calls } = makeProvider();
    const deps = { providerFor: () => provider };
    const a = await seedRunningCampaign('A', '10000000066', 12, deps);
    calls.length = 0;

    // Três varreduras SIMULTÂNEAS — é o cenário real: o cron dispara enquanto
    // a UI faz polling do /tick e um webhook chega. O claim atômico
    // (pending → sending numa instrução) é o que impede a duplicidade.
    await Promise.all([
      processAllPendingCampaigns(repo, deps),
      processAllPendingCampaigns(repo, deps),
      processAllPendingCampaigns(repo, deps),
    ]);

    // Nenhum telefone foi enviado duas vezes.
    expect(calls.length).toBe(new Set(calls).size);
    expect(calls.length).toBe(12);

    // E a auditoria bate: 12 linhas, todas 'sent', uma por contato.
    const sends = await repo.campaigns.listSends(a.campaignId);
    expect(sends.length).toBe(12);
    expect(sends.filter((s) => s.status === 'sent').length).toBe(12);
    expect(new Set(sends.map((s) => s.contact_id)).size).toBe(12);
  });

  it('varredura em fila vazia é barata: não gira em falso até o orçamento acabar', async () => {
    const { provider } = makeProvider();
    const deps = { providerFor: () => provider };
    await seedRunningCampaign('A', '10000000077', 2, deps);
    await processAllPendingCampaigns(repo, deps); // esvazia a fila

    const t0 = Date.now();
    const res = await processAllPendingCampaigns(repo, deps);
    expect(Date.now() - t0).toBeLessThan(2000); // não esperou os 20s de orçamento
    expect(res.processed).toBe(0);
    expect(res.rounds).toBe(1);
  });
});
