import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { startCampaign, processCampaignTick } from '../src/domain/dispatch';
import type { Repo } from '../src/repo';
import type { Instance, Template } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';
import { MetaApiError } from '../src/providers/errors';

let repo: Repo;
let inst: Instance;
let tpl: Template;

/**
 * Provider fake: decide sucesso/falha pelo telefone de destino.
 * - termina em 13 → erro permanente 131026 (número inválido)
 * - termina em 29 → rate-limit 130429 (deve ser retentado)
 */
function makeFakeProvider(opts: { rateLimitFailsForever?: boolean } = {}) {
  const calls: string[] = [];
  const rateLimitAttempts = new Map<string, number>();
  const provider: Provider = {
    type: 'meta',
    capabilities: {
      text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true,
    },
    async sendTemplate(_i, to): Promise<SendResult> {
      calls.push(to);
      if (to.endsWith('13')) {
        throw new MetaApiError('131026', 'Message undeliverable', 400);
      }
      if (to.endsWith('29')) {
        const n = (rateLimitAttempts.get(to) ?? 0) + 1;
        rateLimitAttempts.set(to, n);
        // Falha por rate-limit nas 2 primeiras tentativas; depois passa
        // (a menos que rateLimitFailsForever).
        if (opts.rateLimitFailsForever || n <= 2) {
          throw new MetaApiError('130429', 'Rate limit hit', 429);
        }
      }
      return { waMessageId: 'wamid.' + to + '.' + calls.length, status: 'sent' };
    },
    sendText: () => { throw new Error('não usado'); },
    sendMedia: () => { throw new Error('não usado'); },
    sendButtons: () => { throw new Error('não usado'); },
    sendList: () => { throw new Error('não usado'); },
    sendReaction: () => { throw new Error('não usado'); },
    sendCtaUrl: () => { throw new Error('não usado'); },
  };
  return { provider, calls, rateLimitAttempts };
}

/** Semeia N contatos numa lista e cria a campanha (interval_ms=0 p/ teste). */
async function seedCampaign(n: number, intervalMs = 0) {
  const list = await repo.lists.create({ instance_id: inst.id, name: 'L' });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await repo.contacts.upsert({
      instance_id: inst.id,
      // sufixo controla o comportamento do provider fake
      phone: '55119' + String(100000 + i),
      name: 'C' + i,
      last_seen: null,
    });
    ids.push(c.id);
  }
  await repo.lists.addContacts(inst.id, list.id, ids);
  return repo.campaigns.create({
    instance_id: inst.id,
    name: 'Camp',
    template_id: tpl.id,
    total_recipients: 0,
    interval_ms: intervalMs,
    status: 'draft',
    config: { list_ids: [list.id], variables: { '1': 'name' } },
  });
}

/** Roda ticks até completar (com trava de segurança). */
async function runToCompletion(campaignId: string, deps: { providerFor: () => Provider }, batchSize = 100) {
  for (let i = 0; i < 100; i++) {
    const r = await processCampaignTick(repo, inst, campaignId, deps, { batchSize });
    if (r.status === 'completed') return r;
  }
  throw new Error('não completou em 100 ticks');
}

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  inst = await repo.instances.create({
    name: 'Loja', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
    token: 't', verify_token: 'v', active: true, connection_status: 'connected',
  });
  tpl = await repo.templates.upsert({
    instance_id: inst.id, name: 'promo', category: 'MARKETING', language: 'pt_BR',
    status: 'APPROVED', components: [], wa_template_id: 'tpl1',
  });
});

describe('CRITÉRIO DO PRD: 1000+ contatos com falhas injetadas, 100% logado', () => {
  it('nenhum envio some em silêncio — todo resultado em campaign_sends', async () => {
    const N = 1000;
    const campaign = await seedCampaign(N);
    const { provider } = makeFakeProvider();
    const deps = { providerFor: () => provider };

    const started = await startCampaign(repo, inst, campaign.id, deps);
    expect(started.status).toBe('running');
    expect(started.total_recipients).toBe(N);

    const final = await runToCompletion(campaign.id, deps, 200);
    expect(final.status).toBe('completed');

    // 100% dos resultados logados: sent + failed = N, pending = 0.
    const counts = await repo.campaigns.countSendsByStatus(campaign.id);
    expect(counts.pending).toBe(0);
    expect(counts.sent + counts.failed).toBe(N);

    // Telefones terminados em 13 → falha permanente COM motivo gravado.
    const failed = await repo.campaigns.listSendsByStatus(campaign.id, 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) {
      expect(f.contact_phone.endsWith('13')).toBe(true);
      expect(f.error_code).toBe('131026');
      expect(f.error_message).toBeTruthy(); // motivo auditável
    }

    // Contadores da campanha refletem o placar real.
    const c = await repo.campaigns.getById(inst.id, campaign.id);
    expect(c!.sent_count).toBe(counts.sent);
    expect(c!.failed_count).toBe(counts.failed);
  }, 30000);
});

describe('retry só em rate-limit', () => {
  it('130429 volta pra fila e é retentado até passar; permanente NÃO é retentado', async () => {
    // 3 contatos: normal, rate-limit (..29), permanente (..13)
    const list = await repo.lists.create({ instance_id: inst.id, name: 'L2' });
    const phones = ['5511900000001', '5511900000029', '5511900000013'];
    const ids: string[] = [];
    for (const p of phones) {
      const c = await repo.contacts.upsert({ instance_id: inst.id, phone: p, name: p, last_seen: null });
      ids.push(c.id);
    }
    await repo.lists.addContacts(inst.id, list.id, ids);
    const campaign = await repo.campaigns.create({
      instance_id: inst.id, name: 'C', template_id: tpl.id, total_recipients: 0,
      interval_ms: 0, status: 'draft', config: { list_ids: [list.id], variables: {} },
    });

    const { provider, calls, rateLimitAttempts } = makeFakeProvider();
    const deps = { providerFor: () => provider };
    await startCampaign(repo, inst, campaign.id, deps);
    await runToCompletion(campaign.id, deps, 10);

    const sends = await repo.campaigns.listSends(campaign.id);
    const rl = sends.find((s) => s.contact_phone.endsWith('29'))!;
    const perm = sends.find((s) => s.contact_phone.endsWith('13'))!;
    const ok = sends.find((s) => s.contact_phone.endsWith('01'))!;

    // Rate-limit: retentado (3 tentativas: 2 falhas + 1 sucesso) e terminou sent.
    expect(rl.status).toBe('sent');
    expect(rl.attempts).toBe(3);
    expect(rateLimitAttempts.get(rl.contact_phone)).toBe(3);

    // Permanente: falhou 1x e NUNCA mais foi tentado.
    expect(perm.status).toBe('failed');
    expect(perm.attempts).toBe(1);
    expect(calls.filter((p) => p === perm.contact_phone).length).toBe(1);

    expect(ok.status).toBe('sent');
    expect(ok.attempts).toBe(1);
  });

  it('rate-limit permanente esgota MAX_ATTEMPTS e vira failed (não loop infinito)', async () => {
    const list = await repo.lists.create({ instance_id: inst.id, name: 'L3' });
    const c = await repo.contacts.upsert({
      instance_id: inst.id, phone: '5511900000129', name: 'RL', last_seen: null,
    });
    await repo.lists.addContacts(inst.id, list.id, [c.id]);
    const campaign = await repo.campaigns.create({
      instance_id: inst.id, name: 'C', template_id: tpl.id, total_recipients: 0,
      interval_ms: 0, status: 'draft', config: { list_ids: [list.id], variables: {} },
    });

    const { provider } = makeFakeProvider({ rateLimitFailsForever: true });
    const deps = { providerFor: () => provider };
    await startCampaign(repo, inst, campaign.id, deps);
    const final = await runToCompletion(campaign.id, deps, 10);
    expect(final.status).toBe('completed');

    const sends = await repo.campaigns.listSends(campaign.id);
    expect(sends[0].status).toBe('failed');
    expect(sends[0].attempts).toBe(5); // MAX_ATTEMPTS
    expect(sends[0].error_code).toBe('130429');
  });
});

describe('retomável em lotes', () => {
  it('cada tick processa só um lote; o estado sobrevive entre ticks', async () => {
    const campaign = await seedCampaign(10);
    const { provider } = makeFakeProvider();
    const deps = { providerFor: () => provider };
    await startCampaign(repo, inst, campaign.id, deps);

    // 1º tick: lote de 4 → 6 pendentes.
    const t1 = await processCampaignTick(repo, inst, campaign.id, deps, { batchSize: 4 });
    expect(t1.processed).toBe(4);
    expect(t1.pending).toBe(6);
    expect(t1.status).toBe('running');

    // Simula "outro processo" retomando: novo tick continua de onde parou.
    const t2 = await processCampaignTick(repo, inst, campaign.id, deps, { batchSize: 4 });
    expect(t2.pending).toBe(2);
    const t3 = await processCampaignTick(repo, inst, campaign.id, deps, { batchSize: 4 });
    expect(t3.pending).toBe(0);
    expect(t3.status).toBe('completed');
  });

  it('pause interrompe: tick não processa e mantém pendentes', async () => {
    const campaign = await seedCampaign(5);
    const { provider, calls } = makeFakeProvider();
    const deps = { providerFor: () => provider };
    await startCampaign(repo, inst, campaign.id, deps);
    await processCampaignTick(repo, inst, campaign.id, deps, { batchSize: 2 });
    const before = calls.length;

    await repo.campaigns.update(inst.id, campaign.id, { status: 'paused' });
    const r = await processCampaignTick(repo, inst, campaign.id, deps);
    expect(r.status).toBe('paused');
    expect(r.processed).toBe(0);
    expect(calls.length).toBe(before); // nada novo enviado

    // Retomar: start é idempotente (não duplica a fila).
    await startCampaign(repo, inst, campaign.id, deps);
    const counts = await repo.campaigns.countSendsByStatus(campaign.id);
    expect(counts.sent + counts.pending).toBe(5); // sem duplicatas
  });
});

describe('intervalo entre envios', () => {
  it('respeita interval_ms dentro do lote (espaçamento sequencial)', async () => {
    const campaign = await seedCampaign(3, 120);
    const stamps: number[] = [];
    const provider = makeFakeProvider().provider;
    const timedProvider: Provider = {
      ...provider,
      async sendTemplate(i, to, t, v) {
        stamps.push(Date.now());
        return provider.sendTemplate(i, to, t, v);
      },
    };
    const deps = { providerFor: () => timedProvider };
    await startCampaign(repo, inst, campaign.id, deps);
    await processCampaignTick(repo, inst, campaign.id, deps, { batchSize: 3 });

    expect(stamps.length).toBe(3);
    // Cada envio ao menos ~interval depois do anterior (folga p/ timer).
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(100);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(100);
  });
});

describe('rotas de disparo', () => {
  it('start → tick → sends auditáveis via HTTP', async () => {
    const campaign = await seedCampaign(4);
    const { provider } = makeFakeProvider();
    const app = createApp(repo, { providerFor: () => provider });

    const started = await request(app)
      .post(`/api/instances/${inst.id}/campaigns/${campaign.id}/start`)
      .expect(200);
    expect(started.body.status).toBe('running');

    let status = 'running';
    for (let i = 0; i < 10 && status === 'running'; i++) {
      const t = await request(app)
        .post(`/api/instances/${inst.id}/campaigns/${campaign.id}/tick`)
        .expect(200);
      status = t.body.status;
    }
    expect(status).toBe('completed');

    const sends = await request(app)
      .get(`/api/instances/${inst.id}/campaigns/${campaign.id}/sends`)
      .expect(200);
    expect(sends.body.length).toBe(4);
    expect(sends.body.every((s: { status: string }) => s.status !== 'pending')).toBe(true);
  });

  it('start sem template → 400 com mensagem clara', async () => {
    const list = await repo.lists.create({ instance_id: inst.id, name: 'L' });
    const campaign = await repo.campaigns.create({
      instance_id: inst.id, name: 'SemTpl', template_id: null, total_recipients: 0,
      interval_ms: 0, status: 'draft', config: { list_ids: [list.id], variables: {} },
    });
    const app = createApp(repo);
    const res = await request(app)
      .post(`/api/instances/${inst.id}/campaigns/${campaign.id}/start`)
      .expect(400);
    expect(res.body.error).toContain('template');
  });
});
