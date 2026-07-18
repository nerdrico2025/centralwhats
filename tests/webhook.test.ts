import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { processInboundPayload } from '../src/domain/webhook';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let instance: Instance;

// phone_number_id da Meta é numérico (ex.: '109999888777') — usado como
// fallback de to_number quando display_phone_number não vem no payload.
const PNID = '109999888777';
const VERIFY = 'VT-123';

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  instance = await repo.instances.create({
    name: 'Loja',
    provider_type: 'meta',
    phone_number_id: PNID,
    waba_id: 'WABA1',
    token: 'tok',
    verify_token: VERIFY,
    active: true,
    connection_status: 'connected',
  });
});

// --- Payloads de exemplo (formato Meta Cloud API) ---
function inboundText(id = 'wamid.in1', withName = true) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: PNID },
              contacts: withName
                ? [{ profile: { name: 'Cliente Um' }, wa_id: '5511999998888' }]
                : [{ wa_id: '5511999998888' }],
              messages: [
                {
                  from: '5511999998888',
                  id,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'Olá' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function inboundImage(id = 'wamid.img1') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PNID },
              // Sem contacts[].profile.name → plano B (name null).
              contacts: [{ wa_id: '5511999998888' }],
              messages: [
                {
                  from: '5511999998888',
                  id,
                  type: 'image',
                  image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'foto' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(id: string, status: string, errors?: unknown) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PNID },
              statuses: [{ id, status, recipient_id: '5511999998888', errors }],
            },
          },
        ],
      },
    ],
  };
}

describe('GET /webhook — verificação do desafio', () => {
  it('token válido + mode=subscribe → 200 com challenge', async () => {
    const res = await request(createApp(repo))
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': 'ABC123' })
      .expect(200);
    expect(res.text).toBe('ABC123');
  });

  it('token inválido → 403', async () => {
    await request(createApp(repo))
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'X' })
      .expect(403);
  });
});

describe('POST /webhook — não bloqueia na resposta', () => {
  it('responde 200 SEM depender do processamento (scheduler que descarta a task)', async () => {
    // Scheduler que NÃO executa a task: se a resposta dependesse do
    // processamento, a mensagem seria gravada. Provamos que não é gravada.
    const app = createApp(repo, { scheduleWebhook: () => {} });
    await request(app).post('/webhook').send(inboundText()).expect(200);
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.in1');
    expect(msg).toBeNull(); // resposta 200 veio sem processar
  });

  it('com scheduler real, o processamento em background persiste os dados', async () => {
    const tasks: Promise<void>[] = [];
    const app = createApp(repo, {
      scheduleWebhook: (task) => {
        tasks.push(task());
      },
    });
    await request(app).post('/webhook').send(inboundText()).expect(200);
    await Promise.all(tasks); // aguarda o background só no teste
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.in1');
    expect(msg?.type).toBe('text');
    expect((msg?.content as { body: string }).body).toBe('Olá');
  });
});

describe('processInboundPayload — gravação e dedupe', () => {
  it('inbound de texto grava mensagem, contato (com nome), CRM e last_seen', async () => {
    const r = await processInboundPayload(repo, inboundText());
    expect(r.processedInbound).toBe(1);

    const contact = await repo.contacts.getByPhone(instance.id, '5511999998888');
    expect(contact?.name).toBe('Cliente Um');
    expect(contact?.last_seen).not.toBeNull();

    const crm = await repo.crm.getByContact(instance.id, contact!.id);
    expect(crm?.stage).toBe('lead');

    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.in1');
    expect(msg?.direction).toBe('in');
    expect(msg?.from_number).toBe('5511999998888');
  });

  it('inbound de mídia grava media_id e aplica plano B (name null)', async () => {
    await processInboundPayload(repo, inboundImage());
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.img1');
    expect(msg?.type).toBe('image');
    expect((msg?.content as { media_id: string }).media_id).toBe('MEDIA123');

    const contact = await repo.contacts.getByPhone(instance.id, '5511999998888');
    expect(contact?.name).toBeNull(); // plano B: sem profile.name
  });

  it('deduplica por wa_message_id (idempotência)', async () => {
    const first = await processInboundPayload(repo, inboundText('wamid.dup'));
    const second = await processInboundPayload(repo, inboundText('wamid.dup'));
    expect(first.processedInbound).toBe(1);
    expect(second.processedInbound).toBe(0);
    expect(second.dedupedInbound).toBe(1);

    const msgs = await repo.messages.listByContact(instance.id, '5511999998888');
    expect(msgs.filter((m) => m.wa_message_id === 'wamid.dup').length).toBe(1);
  });

  it('payload de phone_number_id desconhecido é contabilizado, não explode', async () => {
    const r = await processInboundPayload(repo, {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: 'NAO_EXISTE' } } }] }],
    });
    expect(r.skippedNoInstance).toBe(1);
    expect(r.processedInbound).toBe(0);
  });
});

describe('processInboundPayload — status (delivered / failed)', () => {
  async function seedOutbound(waId: string) {
    await repo.messages.create({
      instance_id: instance.id,
      direction: 'out',
      from_number: '15550001111',
      to_number: '5511999998888',
      type: 'text',
      content: { body: 'oi' },
      status: 'sent',
      error_code: null,
      error_message: null,
      wa_message_id: waId,
      campaign_id: null,
    });
  }

  it('status delivered atualiza a mensagem de saída', async () => {
    await seedOutbound('wamid.out1');
    const r = await processInboundPayload(repo, statusPayload('wamid.out1', 'delivered'));
    expect(r.processedStatuses).toBe(1);
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.out1');
    expect(msg?.status).toBe('delivered');
  });

  it('status failed GRAVA errors[].code e errors[].message (não descarta)', async () => {
    await seedOutbound('wamid.out2');
    await processInboundPayload(
      repo,
      statusPayload('wamid.out2', 'failed', [
        { code: 131026, title: 'Message undeliverable', message: 'Receiver incapable' },
      ]),
    );
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.out2');
    expect(msg?.status).toBe('failed');
    expect(msg?.error_code).toBe('131026');
    expect(msg?.error_message).toBe('Receiver incapable');
  });
});
