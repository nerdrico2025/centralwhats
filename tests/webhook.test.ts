import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { resetEnvCache } from '../src/config';
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
/** App Secret fake — a Meta assina o corpo do POST com ele. */
const APP_SECRET = 'app-secret-de-teste-1234567890';
let savedAppSecret: string | undefined;

/**
 * POST /webhook ASSINADO como a Meta assina: HMAC-SHA256 do corpo BRUTO.
 * Manda a string crua (não o objeto) para os bytes assinados serem exatamente
 * os bytes enviados — é essa igualdade que a validação verifica.
 */
function postAssinado(
  app: ReturnType<typeof createApp>,
  payload: unknown,
  opts: { secret?: string; corpoAdulterado?: string; semHeader?: boolean; header?: string } = {},
) {
  const raw = JSON.stringify(payload);
  const sig =
    'sha256=' + createHmac('sha256', opts.secret ?? APP_SECRET).update(raw).digest('hex');
  const req = request(app).post('/webhook').set('Content-Type', 'application/json');
  if (opts.header !== undefined) req.set('X-Hub-Signature-256', opts.header);
  else if (!opts.semHeader) req.set('X-Hub-Signature-256', sig);
  // corpoAdulterado simula alteração em trânsito DEPOIS de assinado.
  return req.send(opts.corpoAdulterado ?? raw);
}

beforeEach(async () => {
  savedAppSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = APP_SECRET;
  resetEnvCache();
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

  // Regressão: falha de conexão com o banco travava a request até o
  // FUNCTION_INVOCATION_TIMEOUT da Vercel (promise sem .catch → Unhandled
  // Rejection, nenhuma resposta enviada). Agora vira 500 + log legível.
  it('falha de banco → 500 explícito (não fica pendurado) e loga a mensagem', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    const brokenRepo = {
      ...repo,
      instances: {
        ...repo.instances,
        list: () => Promise.reject(boom),
      },
    } as unknown as Repo;

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });

    try {
      const res = await request(createApp(brokenRepo))
        .get('/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': 'ABC123' })
        .expect(500);
      expect(res.body.error).toMatch(/banco/i);
      expect(
        errors.some(
          (e) =>
            typeof e === 'string' &&
            e.includes('Erro ao conectar no banco durante verificação do webhook') &&
            e.includes('ECONNREFUSED'),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

afterEach(() => {
  if (savedAppSecret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = savedAppSecret;
  resetEnvCache();
});

describe('GET /webhook — motivo do 403 fica logado (nunca silencioso)', () => {
  /** Captura os console.warn emitidos durante a request. */
  async function get403(app: ReturnType<typeof createApp>, token: string) {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    try {
      await request(app)
        .get('/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '123456' })
        .expect(403);
    } finally {
      spy.mockRestore();
    }
    return warns.join('\n');
  }

  it('banco SEM instâncias → 403 e log diz "NENHUMA instância cadastrada"', async () => {
    // Reproduz a produção: tabela existe (sem erro de banco), porém vazia.
    const emptyRepo = {
      ...repo,
      instances: { ...repo.instances, list: () => Promise.resolve([]) },
    } as unknown as Repo;

    const log = await get403(createApp(emptyRepo), VERIFY);
    expect(log).toContain('Verificação recusada (403)');
    expect(log).toContain('NENHUMA instância cadastrada');
  });

  it('verify_token salvo com espaço sobrando → 403 e log aponta o trim', async () => {
    await repo.instances.update(instance.id, { verify_token: `${VERIFY} ` });
    const log = await get403(createApp(repo), VERIFY);
    expect(log).toContain('bate APÓS trim');
    // Segurança inalterada: espaço sobrando continua sendo 403.
  });

  it('diferença só de maiúsc/minúsc → 403 e log aponta o case', async () => {
    const log = await get403(createApp(repo), VERIFY.toLowerCase());
    expect(log).toContain('ignorando maiúsc/minúsc');
  });

  it('hub.mode inválido → 403 e log distingue do token errado', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(String(args[0]));
    });
    try {
      await request(createApp(repo))
        .get('/webhook')
        .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1' })
        .expect(403);
    } finally {
      spy.mockRestore();
    }
    expect(warns.join('\n')).toContain('hub.mode inválido');
  });

  it('o token recebido NUNCA sai inteiro no log (é segredo)', async () => {
    const segredo = 'xbZWGsrEifU10HTWLCUwrH8DHyMLsayEZpooVGYH0hl3lutva6CzSPpSjv2iG1Iy';
    const log = await get403(createApp(repo), segredo);
    expect(log).not.toContain(segredo);
    expect(log).toContain('64 chars'); // comprimento ajuda a diagnosticar
  });
});

describe('POST /webhook — não bloqueia na resposta', () => {
  it('responde 200 SEM depender do processamento (scheduler que descarta a task)', async () => {
    // Scheduler que NÃO executa a task: se a resposta dependesse do
    // processamento, a mensagem seria gravada. Provamos que não é gravada.
    const app = createApp(repo, { scheduleWebhook: () => {} });
    await postAssinado(app, inboundText()).expect(200);
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
    await postAssinado(app, inboundText()).expect(200);
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

describe('processInboundPayload — isolamento por change', () => {
  /** Uma change de texto (uma por mensagem), no formato Meta. */
  function change(waId: string, from: string) {
    return {
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550001111', phone_number_id: PNID },
        contacts: [{ profile: { name: `Cliente ${waId}` }, wa_id: from }],
        messages: [
          { from, id: waId, timestamp: '1700000000', type: 'text', text: { body: `msg ${waId}` } },
        ],
      },
    };
  }

  it('change que falha no meio NÃO aborta as demais (loga e contabiliza)', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    // Falha transitória de banco só na change do meio.
    const flakyRepo = {
      ...repo,
      messages: {
        ...repo.messages,
        getByWaMessageId: (instanceId: string, waId: string) => {
          if (waId === 'wamid.boom') return Promise.reject(boom);
          return repo.messages.getByWaMessageId(instanceId, waId);
        },
      },
    } as unknown as Repo;

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'WABA1', changes: [change('wamid.ok1', '5511900000001'), change('wamid.boom', '5511900000002')] },
        { id: 'WABA1', changes: [change('wamid.ok2', '5511900000003')] },
      ],
    };

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });

    try {
      const r = await processInboundPayload(flakyRepo, payload);

      // As duas changes válidas foram processadas — antes E depois da que falhou.
      expect(r.processedInbound).toBe(2);
      expect(r.failedChanges).toBe(1);

      expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.ok1')).not.toBeNull();
      expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.boom')).toBeNull();
      // A change DEPOIS da falha é a prova de que o loop não abortou.
      expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.ok2')).not.toBeNull();

      // Falha logada individualmente, com posição e mensagem legível.
      expect(
        errors.some(
          (e) =>
            typeof e === 'string' &&
            e.includes('Falha ao processar change (entry 0, change 1)') &&
            e.includes('ECONNREFUSED'),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
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

/**
 * ASSINATURA DA META (X-Hub-Signature-256).
 *
 * O buraco que isto fecha: até aqui o POST não checava origem NENHUMA.
 * Qualquer um com a URL fabricava "mensagem recebida" com remetente e texto
 * arbitrários — e, com um fluxo de chatbot ativo, provocava ENVIO REAL
 * (custo na conta Meta) e dado falso em contacts/messages/crm_contacts.
 */
describe('POST /webhook — validação da assinatura da Meta', () => {
  /** App que executa o background na hora, para medir se processou de fato. */
  function appQueProcessa() {
    const tasks: Promise<void>[] = [];
    const app = createApp(repo, { scheduleWebhook: (t) => { tasks.push(t()); } });
    return { app, tasks };
  }

  it('assinatura VÁLIDA → 200 e o payload é processado', async () => {
    const { app, tasks } = appQueProcessa();
    await postAssinado(app, inboundText()).expect(200);
    await Promise.all(tasks);
    const msg = await repo.messages.getByWaMessageId(instance.id, 'wamid.in1');
    expect(msg).not.toBeNull();
  });

  it('SEM header de assinatura → 401 e NADA é processado', async () => {
    const { app, tasks } = appQueProcessa();
    await postAssinado(app, inboundText(), { semHeader: true }).expect(401);
    await Promise.all(tasks);
    expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.in1')).toBeNull();
  });

  it('assinatura de OUTRO segredo → 401 (App Secret errado não passa)', async () => {
    const { app, tasks } = appQueProcessa();
    await postAssinado(app, inboundText(), { secret: 'segredo-do-atacante' }).expect(401);
    await Promise.all(tasks);
    expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.in1')).toBeNull();
  });

  it('CORPO ADULTERADO depois de assinado → 401', async () => {
    // Assinatura legítima de um payload, corpo trocado em trânsito: é o
    // ataque que o HMAC existe para pegar.
    const original = inboundText();
    const adulterado = JSON.stringify(inboundText()).replace('Olá', 'PAYLOAD TROCADO');
    const { app, tasks } = appQueProcessa();
    await postAssinado(app, original, { corpoAdulterado: adulterado }).expect(401);
    await Promise.all(tasks);
    expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.in1')).toBeNull();
  });

  it('header fora do formato "sha256=<hex>" → 401', async () => {
    const { app } = appQueProcessa();
    await postAssinado(app, inboundText(), { header: 'md5=abcdef' }).expect(401);
    await postAssinado(app, inboundText(), { header: 'só-lixo' }).expect(401);
    await postAssinado(app, inboundText(), { header: 'sha256=' }).expect(401);
    // Hex do tamanho certo mas inválido não pode explodir o processo.
    await postAssinado(app, inboundText(), { header: 'sha256=' + 'zz'.repeat(32) }).expect(401);
  });

  it('FAIL-CLOSED: sem META_APP_SECRET configurado, recusa TUDO', async () => {
    delete process.env.META_APP_SECRET;
    resetEnvCache();
    const { app, tasks } = appQueProcessa();
    // Nem assinado passa — sem o segredo não há como distinguir a Meta.
    await postAssinado(app, inboundText()).expect(401);
    await postAssinado(app, inboundText(), { semHeader: true }).expect(401);
    await Promise.all(tasks);
    expect(await repo.messages.getByWaMessageId(instance.id, 'wamid.in1')).toBeNull();
  });

  it('a recusa é LOGADA com motivo acionável (nunca silenciosa)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app } = appQueProcessa();
    await postAssinado(app, inboundText(), { semHeader: true }).expect(401);
    const log = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(log).toContain('POST RECUSADO');
    expect(log).toContain('X-Hub-Signature-256');
    warn.mockRestore();
  });

  it('o GET de verificação NÃO é afetado (continua no verify_token)', async () => {
    const app = createApp(repo);
    // Sem nenhuma assinatura — o GET nunca é assinado pela Meta desse jeito.
    await request(app)
      .get(`/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`)
      .expect(200)
      .expect('42');
  });
});
