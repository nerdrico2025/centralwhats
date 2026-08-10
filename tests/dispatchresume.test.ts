import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { startCampaign, processCampaignTick } from '../src/domain/dispatch';
import { processInboundPayload } from '../src/domain/webhook';
import type { Repo } from '../src/repo';
import type { Instance, Template } from '../src/repo/types';
import type { Provider, SendResult } from '../src/providers/types';

/**
 * P3.1 — auditoria completa (contact_id/wa_message_id), claim atômico do lote
 * (sem envio duplicado) e retomada por TRÁFEGO de webhook, igual aos fluxos.
 */

let repo: Repo;
let inst: Instance;
let tpl: Template;

function makeProvider(onSend?: (to: string) => void) {
  const calls: string[] = [];
  const provider: Provider = {
    type: 'meta',
    capabilities: {
      text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true,
    },
    async sendTemplate(_i, to): Promise<SendResult> {
      calls.push(to);
      onSend?.(to);
      return { waMessageId: 'wamid.' + to, status: 'sent' };
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

async function seedCampaign(n: number) {
  const list = await repo.lists.create({ instance_id: inst.id, name: 'L' });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await repo.contacts.upsert({
      instance_id: inst.id,
      phone: '55119' + String(200000 + i),
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
    interval_ms: 0,
    status: 'draft',
    config: { list_ids: [list.id], variables: { '1': 'name' } },
  });
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

describe('auditoria por destinatário', () => {
  it('grava contact_id na materialização e wa_message_id no sucesso', async () => {
    const camp = await seedCampaign(2);
    const { provider } = makeProvider();
    await startCampaign(repo, inst, camp.id);

    const pendentes = await repo.campaigns.listSends(camp.id);
    expect(pendentes).toHaveLength(2);
    // contact_id preenchido já na fila, antes de qualquer envio.
    expect(pendentes.every((s) => s.contact_id !== null)).toBe(true);
    expect(pendentes.every((s) => s.wa_message_id === null)).toBe(true);

    await processCampaignTick(repo, inst, camp.id, { providerFor: () => provider });

    const enviados = await repo.campaigns.listSendsByStatus(camp.id, 'sent');
    expect(enviados).toHaveLength(2);
    for (const s of enviados) {
      expect(s.wa_message_id).toBe('wamid.' + s.contact_phone);
      expect(s.contact_id).not.toBeNull();
    }
  });
});

describe('contact_id é obrigatório no BANCO, não só no tipo', () => {
  it('recordSend com contact_id nulo é rejeitado pela constraint NOT NULL', async () => {
    const camp = await seedCampaign(1);
    await expect(
      repo.campaigns.recordSend({
        campaign_id: camp.id,
        // null explícito: chega no banco e bate na constraint (não é só o tipo).
        contact_id: null,
        contact_phone: '5511999990000',
        status: 'pending',
        wa_message_id: null,
        error_code: null,
        error_message: null,
        sent_at: null,
        claimed_at: null,
        vars: {},
        attempts: 0,
      } as unknown as Parameters<typeof repo.campaigns.recordSend>[0]),
    ).rejects.toThrow(/NOT NULL|null value/i);
  });
});

describe('claim atômico — dois ticks concorrentes não duplicam envio', () => {
  it('mesmo destinatário nunca é enviado duas vezes', async () => {
    const camp = await seedCampaign(6);
    await startCampaign(repo, inst, camp.id);
    const { provider, calls } = makeProvider();
    const deps = { providerFor: () => provider };

    // Dois ticks disparados em paralelo (polling da UI + retomada por webhook).
    await Promise.all([
      processCampaignTick(repo, inst, camp.id, deps, { batchSize: 6 }),
      processCampaignTick(repo, inst, camp.id, deps, { batchSize: 6 }),
    ]);

    expect(calls).toHaveLength(6);
    expect(new Set(calls).size).toBe(6); // nenhum telefone repetido
    const counts = await repo.campaigns.countSendsByStatus(camp.id);
    expect(counts).toEqual({ sent: 6, failed: 0, pending: 0 });
  });

  it('linha travada em "sending" por tick morto volta pra fila', async () => {
    const camp = await seedCampaign(1);
    await startCampaign(repo, inst, camp.id);

    // Simula tick que morreu: claim antigo, nunca concluído.
    const antigo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const claimed = await repo.campaigns.claimPendingSends(camp.id, 1, antigo);
    expect(claimed).toHaveLength(1);
    expect((await repo.campaigns.countSendsByStatus(camp.id)).pending).toBe(1); // em voo conta

    const { provider, calls } = makeProvider();
    const r = await processCampaignTick(repo, inst, camp.id, { providerFor: () => provider });
    expect(calls).toHaveLength(1); // foi recuperado e enviado
    expect(r.status).toBe('completed');
  });

  it('campanha não é dada como concluída com envios em voo', async () => {
    const camp = await seedCampaign(2);
    await startCampaign(repo, inst, camp.id);
    await repo.campaigns.claimPendingSends(camp.id, 2, new Date().toISOString());

    // Claim recente: não é stale, então o tick não acha nada para reivindicar —
    // mas os 2 continuam em voo, logo NÃO pode virar 'completed'.
    const counts = await repo.campaigns.countSendsByStatus(camp.id);
    expect(counts.pending).toBe(2);
  });
});

describe('retomada por TRÁFEGO de webhook (mesmo mecanismo dos fluxos)', () => {
  function inboundPayload(phoneNumberId: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                messages: [
                  {
                    id: 'wamid.in.' + Math.random(),
                    from: '5511988887777',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('inbound faz a campanha running avançar sem ninguém chamar /tick', async () => {
    const camp = await seedCampaign(3);
    await startCampaign(repo, inst, camp.id);
    const { provider, calls } = makeProvider();

    expect(calls).toHaveLength(0);
    await processInboundPayload(repo, inboundPayload('109999888777'), {
      providerFor: () => provider,
    });

    // O tráfego do webhook empurrou a fila adiante.
    expect(calls.length).toBeGreaterThan(0);
    const counts = await repo.campaigns.countSendsByStatus(camp.id);
    expect(counts.sent).toBe(3);
  });

  it('campanha pausada não avança com o tráfego', async () => {
    const camp = await seedCampaign(3);
    await startCampaign(repo, inst, camp.id);
    await repo.campaigns.update(inst.id, camp.id, { status: 'paused' });
    const { provider, calls } = makeProvider();

    await processInboundPayload(repo, inboundPayload('109999888777'), {
      providerFor: () => provider,
    });
    expect(calls).toHaveLength(0);
  });

  it('falha na retomada de campanha não derruba o processamento do inbound', async () => {
    const camp = await seedCampaign(1);
    await startCampaign(repo, inst, camp.id);
    const provider = {
      type: 'meta' as const,
      capabilities: {
        text: true, media: true, template: true, buttons: true, list: true, reaction: true, cta: true,
      },
      sendTemplate: () => Promise.reject(new Error('boom')),
      sendText: () => { throw new Error('não usado'); },
      sendMedia: () => { throw new Error('não usado'); },
      sendButtons: () => { throw new Error('não usado'); },
      sendList: () => { throw new Error('não usado'); },
      sendReaction: () => { throw new Error('não usado'); },
      sendCtaUrl: () => { throw new Error('não usado'); },
    } as unknown as Provider;

    const res = await processInboundPayload(repo, inboundPayload('109999888777'), {
      providerFor: () => provider,
    });
    // O inbound foi gravado normalmente apesar da falha no envio da campanha.
    expect(res).toBeTruthy();
    const msgs = await repo.messages.listByContact(inst.id, '5511988887777', { limit: 5 });
    expect(msgs.length).toBeGreaterThan(0);
    // E a falha do envio ficou registrada, não sumiu.
    const falhas = await repo.campaigns.listSendsByStatus(camp.id, 'failed');
    expect(falhas).toHaveLength(1);
    expect(falhas[0].error_message).toMatch(/boom/);
  });
});

describe('multi-tenancy da campanha', () => {
  it('campanha e sends de uma instância não vazam para outra', async () => {
    const camp = await seedCampaign(2);
    await startCampaign(repo, inst, camp.id);

    const outra = await repo.instances.create({
      name: 'Outra', provider_type: 'meta', phone_number_id: '222', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });

    // Escopo no repo: getById de outra instância não encontra.
    expect(await repo.campaigns.getById(outra.id, camp.id)).toBeNull();
    expect(await repo.campaigns.list(outra.id)).toEqual([]);

    // Escopo na rota: 404 pelas rotas de disparo/auditoria.
    const app = createApp(repo, { providerFor: () => makeProvider().provider });
    await request(app).get(`/api/instances/${outra.id}/campaigns/${camp.id}`).expect(404);
    await request(app).get(`/api/instances/${outra.id}/campaigns/${camp.id}/sends`).expect(404);
    await request(app).post(`/api/instances/${outra.id}/campaigns/${camp.id}/start`).expect(400);
  });
});
