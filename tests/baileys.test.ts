import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { sendViaProvider } from '../src/domain/messaging';
import {
  BaileysWorker,
  describeDisconnect,
  extractBaileysInbound,
  shouldReconnect,
  toJid,
  toSocketContent,
  type BaileysSocketLike,
} from '../src/worker/baileysWorker';
import { resolveWaVersion } from '../src/worker/realSocket';
import { makeDbAuthState } from '../src/worker/dbAuthState';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

let repo: Repo;
let inst: Instance;
const PHONE = '5511999998888';

function makeFakeSocket(opts: { failFor?: (jid: string) => boolean } = {}) {
  const sent: { jid: string; content: Record<string, unknown> }[] = [];
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  let counter = 0;
  const socket: BaileysSocketLike = {
    ev: {
      on(event, cb) {
        const list = handlers.get(event) ?? [];
        list.push(cb as (arg: unknown) => void);
        handlers.set(event, list);
      },
    },
    async sendMessage(jid, content) {
      if (opts.failFor?.(jid)) throw new Error('socket caiu no meio do envio');
      sent.push({ jid, content });
      return { key: { id: 'BAILEYS.' + ++counter } };
    },
  };
  const emit = (event: string, arg: unknown): void => {
    for (const cb of handlers.get(event) ?? []) cb(arg);
  };
  return { socket, sent, emit };
}

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  inst = await repo.instances.create({
    org_id: 'org_default',
    name: 'Zap', provider_type: 'baileys', phone_number_id: '5511000000000', waba_id: null,
    token: null, verify_token: null, active: true, connection_status: 'disconnected',
  });
});

describe('conversões puras', () => {
  it('toJid e toSocketContent (texto, mídia, botões→texto com opções)', () => {
    expect(toJid('+55 11 99999-8888')).toBe('5511999998888@s.whatsapp.net');
    expect(toSocketContent({ type: 'text', text: 'oi' }, 'x')).toEqual({ text: 'oi' });
    expect(
      toSocketContent({ type: 'media', media: { kind: 'image', url: 'https://x/a.png', caption: 'c' } }, 'x'),
    ).toEqual({ image: { url: 'https://x/a.png' }, caption: 'c' });
    const btn = toSocketContent(
      { type: 'buttons', body: 'Escolha:', buttons: [{ id: 'sim', title: 'Sim' }, { id: 'nao', title: 'Não' }] },
      'x',
    );
    expect(btn.text).toContain('Escolha:');
    expect(btn.text).toContain('1. Sim');
    expect(btn.text).toContain('2. Não');
  });

  it('shouldReconnect: 401 (logout) não reconecta; resto sim', () => {
    expect(shouldReconnect({ error: { output: { statusCode: 401 } } })).toBe(false);
    expect(shouldReconnect({ error: { output: { statusCode: 428 } } })).toBe(true);
    expect(shouldReconnect(undefined)).toBe(true);
  });

  it('extractBaileysInbound: texto, button_reply e grupo ignorado', () => {
    const text = extractBaileysInbound({
      key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'W1' },
      pushName: 'Ana',
      message: { conversation: 'oi' },
    });
    expect(text).toMatchObject({
      waMessageId: 'W1', from: PHONE, type: 'text',
      profileName: 'Ana', flowInput: { text: 'oi', replyId: null },
    });

    const btn = extractBaileysInbound({
      key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'W2' },
      message: { buttonsResponseMessage: { selectedButtonId: 'sim', selectedDisplayText: 'Sim' } },
    });
    expect(btn?.flowInput).toEqual({ text: 'Sim', replyId: 'sim' });

    // Grupo: fora de escopo — ignorado.
    expect(
      extractBaileysInbound({ key: { remoteJid: '123@g.us', id: 'W3' }, message: { conversation: 'x' } }),
    ).toBeNull();
  });
});

describe('web → outbox (a camada web nunca toca o socket)', () => {
  it('sendViaProvider em instância baileys enfileira e loga como queued, linkados', async () => {
    const { message, result } = await sendViaProvider(repo, inst, {
      type: 'text', to: PHONE, text: 'Olá do painel',
    });
    expect(result.status).toBe('queued');
    expect(message.status).toBe('queued');
    expect(message.wa_message_id).toBeNull();

    const pending = await repo.outbox.listByInstance(inst.id, 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].payload).toEqual({ type: 'text', text: 'Olá do painel' });
    expect(pending[0].message_id).toBe(message.id); // linkado p/ o worker confirmar
  });

  it('template em baileys → barrado por capabilities (422 na rota, erro aqui)', async () => {
    await expect(
      sendViaProvider(repo, inst, { type: 'template', to: PHONE, template: { name: 'x', language: 'pt_BR' } }),
    ).rejects.toThrow(/não é suportado/);
  });
});

describe('worker — consumo da outbox', () => {
  async function workerWithSocket(failFor?: (jid: string) => boolean) {
    const fake = makeFakeSocket({ failFor });
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);
    return { worker, fake };
  }

  it('envia o pendente pelo socket e confirma queued→sent no messages', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const { worker, fake } = await workerWithSocket();

    const r = await worker.processOutboxOnce();
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(fake.sent[0].jid).toBe(PHONE + '@s.whatsapp.net');
    expect(fake.sent[0].content).toEqual({ text: 'oi' });

    const out = await repo.outbox.listByInstance(inst.id, 'sent');
    expect(out.length).toBe(1);
    const updated = await repo.messages.getByWaMessageId(inst.id, 'BAILEYS.1');
    expect(updated?.id).toBe(message.id);
    expect(updated?.status).toBe('sent');
  });

  it('falha no socket: outbox failed + messages failed COM motivo (nada se perde)', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const { worker } = await workerWithSocket(() => true);

    const r = await worker.processOutboxOnce();
    expect(r).toEqual({ sent: 0, failed: 1 });
    const failedItems = await repo.outbox.listByInstance(inst.id, 'failed');
    expect(failedItems[0].error).toContain('socket caiu');

    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    const failed = msgs.find((mm) => mm.id === message.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_message).toContain('socket caiu');
  });

  it('claim atômico: dois consumos simultâneos não enviam o mesmo item duas vezes', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'unico' });
    const { worker, fake } = await workerWithSocket();
    const [a, b] = await Promise.all([worker.processOutboxOnce(), worker.processOutboxOnce()]);
    expect(a.sent + b.sent).toBe(1);
    expect(fake.sent.length).toBe(1);
  });
});

describe('worker — inbound pelo socket usa o MESMO motor (reuso total)', () => {
  it('mensagem recebida grava tudo e o fluxo responde REATIVAMENTE pelo socket', async () => {
    await repo.flows.create({
      instance_id: inst.id, name: 'boas-vindas', trigger_keywords: ['oi'],
      nodes: [
        { id: 's', type: 'start' },
        { id: 'm', type: 'message', data: { text: 'Olá {{nome}}, chegou pelo Baileys!' } },
        { id: 'z', type: 'end' },
      ],
      edges: [
        { source: 's', target: 'm' },
        { source: 'm', target: 'z' },
      ],
      active: true,
    });
    const fake = makeFakeSocket();
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await worker.handleIncoming(inst, {
      key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'IN1' },
      pushName: 'Ana',
      message: { conversation: 'oi' },
    });

    // Inbound gravado (mesma cadeia do webhook: contato, CRM, mensagem).
    const contact = await repo.contacts.getByPhone(inst.id, PHONE);
    expect(contact?.name).toBe('Ana');
    const inbound = await repo.messages.getByWaMessageId(inst.id, 'IN1');
    expect(inbound?.direction).toBe('in');

    // Resposta do fluxo saiu DIRETO pelo socket (reativa, sem outbox).
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].content).toEqual({ text: 'Olá Ana, chegou pelo Baileys!' });
    expect((await repo.outbox.listByInstance(inst.id)).length).toBe(0);

    // Dedupe: mesmo wa_message_id não duplica.
    await worker.handleIncoming(inst, {
      key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'IN1' },
      message: { conversation: 'oi' },
    });
    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    expect(msgs.filter((mm) => mm.wa_message_id === 'IN1').length).toBe(1);
  });
});

describe('worker — QR, status e reconexão', () => {
  it('qr → pending; open → connected (qr limpo); logout limpa a sessão', async () => {
    const fake = makeFakeSocket();
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await worker.handleConnectionUpdate(inst, { qr: 'QR-DATA-123' });
    expect(await repo.baileysAuth.get(inst.id, 'qr')).toBe('QR-DATA-123');
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('pending');

    await worker.handleConnectionUpdate(inst, { connection: 'open' });
    expect(await repo.baileysAuth.get(inst.id, 'qr')).toBeNull();
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('connected');

    // Logout (401): desconecta e LIMPA a sessão (permite novo pareamento).
    await repo.baileysAuth.set(inst.id, 'creds', '"algo"');
    await worker.handleConnectionUpdate(inst, {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('disconnected');
    expect(await repo.baileysAuth.get(inst.id, 'creds')).toBeNull();
  });

  it('close limpa o QR persistido (QR morto não pode continuar no painel)', async () => {
    const fake = makeFakeSocket();
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => fake.socket,
      maxReconnectDelayMs: 1,
    });
    await worker.connectInstance(inst);

    await worker.handleConnectionUpdate(inst, { qr: 'QR-QUE-VAI-MORRER' });
    expect(await repo.baileysAuth.get(inst.id, 'qr')).toBe('QR-QUE-VAI-MORRER');

    // 405: handshake rejeitado ANTES de parear — o QR daquele socket morreu.
    await worker.handleConnectionUpdate(inst, {
      connection: 'close',
      lastDisconnect: {
        error: { message: 'Connection Failure', output: { statusCode: 405 }, data: { reason: '405' } },
      },
    });
    expect(await repo.baileysAuth.get(inst.id, 'qr')).toBeNull();
    await worker.stop();
  });

  it('scan → isNewLogin → close 515 → open: o meio é "connecting", nunca "disconnected"', async () => {
    let connects = 0;
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => {
        connects++;
        return makeFakeSocket().socket;
      },
      maxReconnectDelayMs: 1,
    });
    await worker.connectInstance(inst);

    // 1. QR na tela, esperando o scan.
    await worker.handleConnectionUpdate(inst, { qr: 'QR-PRA-ESCANEAR' });
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('pending');

    // 2. Scan aceito: o WhatsApp confirma o pareamento (QR já não serve).
    await worker.handleConnectionUpdate(inst, { isNewLogin: true });
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('connecting');
    expect(await repo.baileysAuth.get(inst.id, 'qr')).toBeNull();

    // 3. 515: reinício MANDADO pelo WhatsApp — etapa do sucesso, não queda.
    await worker.handleConnectionUpdate(inst, {
      connection: 'close',
      lastDisconnect: { error: { message: 'Restart Required', output: { statusCode: 515 } } },
    });
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('connecting');

    // 4. Reconecta e abre.
    await new Promise((r) => setTimeout(r, 30));
    expect(connects).toBe(2);
    await worker.handleConnectionUpdate(inst, { connection: 'open' });
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('connected');
    await worker.stop();
  });

  it('515 zera o backoff acumulado; falha real continua escalando', async () => {
    const atrasos: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = ((cb: () => void, ms?: number) => {
      atrasos.push(ms ?? 0);
      return realSetTimeout(cb, 1);
    }) as typeof globalThis.setTimeout;
    globalThis.setTimeout = spy;
    try {
      const worker = new BaileysWorker(repo, { socketFactory: async () => makeFakeSocket().socket });
      await worker.connectInstance(inst);

      // Duas quedas reais: backoff escala (1s, 2s).
      const queda = {
        connection: 'close',
        lastDisconnect: { error: { message: 'Connection Lost', output: { statusCode: 428 } } },
      };
      await worker.handleConnectionUpdate(inst, queda);
      await worker.handleConnectionUpdate(inst, queda);
      expect(atrasos).toEqual([1000, 2000]);

      // O 515 chega DEPOIS: zera o acumulado e volta pro mínimo (1s), em vez
      // de esperar 4s logo após um scan bem-sucedido.
      await worker.handleConnectionUpdate(inst, {
        connection: 'close',
        lastDisconnect: { error: { message: 'Restart Required', output: { statusCode: 515 } } },
      });
      expect(atrasos).toEqual([1000, 2000, 1000]);

      // E uma falha real seguinte volta a escalar normalmente.
      await worker.handleConnectionUpdate(inst, queda);
      expect(atrasos).toEqual([1000, 2000, 1000, 2000]);
      await worker.stop();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('describeDisconnect extrai statusCode/reason do Boom (não o texto genérico)', () => {
    expect(
      describeDisconnect({
        error: { message: 'Connection Failure', output: { statusCode: 405 }, data: { reason: '405' } },
      }),
    ).toEqual({ statusCode: 405, reason: '405', message: 'Connection Failure' });
    expect(describeDisconnect(undefined)).toEqual({
      statusCode: null,
      reason: null,
      message: null,
    });
  });

  it('queda comum reconecta sozinho (nova chamada à factory)', async () => {
    let connects = 0;
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => {
        connects++;
        return makeFakeSocket().socket;
      },
      maxReconnectDelayMs: 1, // backoff mínimo p/ teste
    });
    await worker.connectInstance(inst);
    expect(connects).toBe(1);

    await worker.handleConnectionUpdate(inst, {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    // Espera o backoff (1ms) disparar a reconexão.
    await new Promise((r) => setTimeout(r, 30));
    expect(connects).toBe(2);
    await worker.stop();
  });
});

describe('versão do protocolo WA (fix do 405)', () => {
  const LIB_DEFAULT: [number, number, number] = [2, 3000, 1035194821];

  it('usa a versão buscada quando o fetch responde', async () => {
    const info = await resolveWaVersion({
      fetchLatest: async () => ({ version: [2, 3000, 1043857760] }),
      fallback: () => LIB_DEFAULT,
    });
    expect(info).toEqual({ version: [2, 3000, 1043857760], source: 'fetch' });
  });

  it('fetch fora do ar → fallback no default da lib, sem lançar', async () => {
    const info = await resolveWaVersion({
      fetchLatest: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
      fallback: () => LIB_DEFAULT,
    });
    expect(info.version).toEqual(LIB_DEFAULT);
    expect(info.source).toBe('fallback');
    expect(info.error).toContain('ENOTFOUND');
  });

  it('resposta malformada também cai no fallback', async () => {
    const info = await resolveWaVersion({
      fetchLatest: async () => ({ version: undefined as never }),
      fallback: () => LIB_DEFAULT,
    });
    expect(info.version).toEqual(LIB_DEFAULT);
    expect(info.source).toBe('fallback');
  });

  it('sem fetch E sem default legível: version null (lib decide), nunca lança', async () => {
    const info = await resolveWaVersion({
      fetchLatest: async () => {
        throw new Error('rede fora');
      },
      fallback: () => {
        throw new Error('pacote ilegível');
      },
    });
    expect(info).toEqual({ version: null, source: 'fallback', error: 'rede fora' });
  });
});

describe('rotas de QR (painel)', () => {
  it('GET /qr devolve estado; /qr.svg renderiza o QR escaneável', async () => {
    const app = createApp(repo);
    // Sem QR ainda: json com null; svg → 404.
    const empty = await request(app).get(`/api/instances/${inst.id}/qr`).expect(200);
    expect(empty.body.qr).toBeNull();
    await request(app).get(`/api/instances/${inst.id}/qr.svg`).expect(404);

    // Worker gerou o QR: json traz o dado e o SVG renderiza.
    await repo.baileysAuth.set(inst.id, 'qr', 'QR-DATA-PAREAMENTO');
    const info = await request(app).get(`/api/instances/${inst.id}/qr`).expect(200);
    expect(info.body.qr).toBe('QR-DATA-PAREAMENTO');

    const svg = await request(app)
      .get(`/api/instances/${inst.id}/qr.svg`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => cb(null, data));
      })
      .expect(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(String(svg.body)).toContain('<svg');
  });

  it('QR em instância Meta → 400', async () => {
    const meta = await repo.instances.create({
    org_id: 'org_default',
      name: 'Meta', provider_type: 'meta', phone_number_id: '111', waba_id: null,
      token: 't', verify_token: 'v', active: true, connection_status: 'connected',
    });
    const app = createApp(repo);
    await request(app).get(`/api/instances/${meta.id}/qr`).expect(400);
  });
});

describe('sessão persistida no banco (sobrevive a restart)', () => {
  it('creds salvas por um "processo" são restauradas por outro', async () => {
    // "Processo 1": cria credenciais e salva.
    const s1 = await makeDbAuthState(repo, inst.id);
    const regId = (s1.state.creds as { registrationId: number }).registrationId;
    expect(typeof regId).toBe('number');
    await s1.saveCreds();
    await s1.state.keys.set({ 'pre-key': { '1': { keyId: 1 } } });

    // ===== RESTART DO WORKER =====
    // "Processo 2": nada em memória — restaura tudo do banco.
    const s2 = await makeDbAuthState(repo, inst.id);
    expect((s2.state.creds as { registrationId: number }).registrationId).toBe(regId);
    const keys = await s2.state.keys.get('pre-key', ['1']);
    expect(keys['1']).toMatchObject({ keyId: 1 });
  });
});
