import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { createApp } from '../src/http/app';
import { sendViaProvider } from '../src/domain/messaging';
import {
  analisarInbound,
  BaileysWorker,
  describeDisconnect,
  extractBaileysInbound,
  resolverEnderecoInbound,
  shouldReconnect,
  toJid,
  toSocketContent,
  type BaileysSocketLike,
} from '../src/worker/baileysWorker';
import { resolveWaVersion } from '../src/worker/realSocket';
import { extractErro, makeBaileysLogger } from '../src/worker/baileysLogger';
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
    expect(r).toEqual({ sent: 1, failed: 0, requeued: 0 });
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
    // 'socket caiu no meio do envio' não casa com nenhum mapeamento conhecido:
    // vira unknown/não-retryable — falha definitiva, com o motivo preservado.
    expect(r).toEqual({ sent: 0, failed: 1, requeued: 0 });
    const failedItems = await repo.outbox.listByInstance(inst.id, 'failed');
    expect(failedItems[0].error).toContain('socket caiu');
    expect(failedItems[0].error).toContain('unknown');

    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    const failed = msgs.find((mm) => mm.id === message.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_message).toContain('socket caiu');
  });

  it('erro TRANSITÓRIO devolve o item à fila em vez de matá-lo (§3.5)', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    // 428 = socket fechado: transitório, vale tentar de novo.
    const fake = makeFakeSocket();
    fake.socket.sendMessage = async () => {
      throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    const r = await worker.processOutboxOnce();
    expect(r).toEqual({ sent: 0, failed: 0, requeued: 1 });

    // Volta para 'pending' COM o motivo — nunca some da fila em silêncio.
    const pend = await repo.outbox.listByInstance(inst.id, 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0].error).toContain('transient');

    // E a mensagem NÃO é marcada como falha: ela ainda vai ser enviada.
    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    expect(msgs.find((mm) => mm.id === message.id)?.status).toBe('queued');
  });

  it('transitório em item VELHO vira falha (não gira para sempre)', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const fake = makeFakeSocket();
    fake.socket.sendMessage = async () => {
      throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    };
    // outboxStaleMinutes = 0: todo item já nasce "velho" para o teto de idade.
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => fake.socket,
      outboxStaleMinutes: 0,
    });
    await worker.connectInstance(inst);
    await new Promise((r) => setTimeout(r, 10));

    const r = await worker.processOutboxOnce();
    expect(r).toEqual({ sent: 0, failed: 1, requeued: 0 });
    const failed = await repo.outbox.listByInstance(inst.id, 'failed');
    expect(failed[0].error).toContain('428');
  });

  it('THROTTLE: envios consecutivos da MESMA instância respeitam o intervalo', async () => {
    for (const t of ['um', 'dois', 'três']) {
      await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: t });
    }
    const carimbos: number[] = [];
    const fake = makeFakeSocket();
    const original = fake.socket.sendMessage.bind(fake.socket);
    fake.socket.sendMessage = async (jid, content) => {
      carimbos.push(Date.now());
      return original(jid, content);
    };
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => fake.socket,
      minSendIntervalMs: 60,
    });
    await worker.connectInstance(inst);

    const r = await worker.processOutboxOnce();
    expect(r.sent).toBe(3);
    expect(carimbos).toHaveLength(3);
    // O primeiro sai na hora; os seguintes esperam o intervalo.
    for (let i = 1; i < carimbos.length; i++) {
      expect(
        carimbos[i] - carimbos[i - 1],
        `intervalo entre o envio ${i} e o ${i + 1}`,
      ).toBeGreaterThanOrEqual(55); // folga p/ imprecisão do timer
    }
    await worker.stop();
  });

  it('THROTTLE: duas instâncias Baileys NÃO se bloqueiam (cada número tem o seu)', async () => {
    const inst2 = await repo.instances.create({
      org_id: 'org_default',
      name: 'Zap 2', provider_type: 'baileys', phone_number_id: '5511000000001', waba_id: null,
      token: null, verify_token: null, active: true, connection_status: 'disconnected',
    });
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'a' });
    await sendViaProvider(repo, inst2, { type: 'text', to: PHONE, text: 'b' });

    const porInstancia = new Map<string, number>();
    const worker = new BaileysWorker(repo, {
      socketFactory: async (i) => {
        const f = makeFakeSocket();
        const orig = f.socket.sendMessage.bind(f.socket);
        f.socket.sendMessage = async (jid, content) => {
          porInstancia.set(i.id, Date.now());
          return orig(jid, content);
        };
        return f.socket;
      },
      // Intervalo LONGO: se houvesse throttle global, a 2ª instância esperaria
      // por ele e o teste estouraria o limite abaixo.
      minSendIntervalMs: 5000,
    });
    await worker.connectInstance(inst);
    await worker.connectInstance(inst2);

    const inicio = Date.now();
    const r = await worker.processOutboxOnce();
    const decorrido = Date.now() - inicio;

    expect(r.sent).toBe(2);
    expect(porInstancia.size).toBe(2); // as duas enviaram
    expect(decorrido, 'as duas devem sair sem esperar uma pela outra').toBeLessThan(1000);
    await worker.stop();
  });

  it('THROTTLE não atrapalha o retry: transitório continua voltando à fila', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const fake = makeFakeSocket();
    fake.socket.sendMessage = async () => {
      throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    };
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => fake.socket,
      minSendIntervalMs: 10,
    });
    await worker.connectInstance(inst);

    const r = await worker.processOutboxOnce();
    expect(r).toEqual({ sent: 0, failed: 0, requeued: 1 });
    expect(await repo.outbox.listByInstance(inst.id, 'pending')).toHaveLength(1);
    await worker.stop();
  });

  it('INVARIANTE: o wa_message_id está gravado ANTES do socket.sendMessage', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const fake = makeFakeSocket();
    fake.socket.gerarMessageId = () => 'ID.RESERVADO.1';
    // No instante do envio, a linha JÁ tem que ter o id — é isto que vence o
    // eco que a lib agenda num nextTick dentro do sendMessage.
    let gravadoNoMomentoDoEnvio = null;
    let idRecebidoPeloSocket;
    fake.socket.sendMessage = async (_jid, _content, opts) => {
      idRecebidoPeloSocket = opts?.messageId;
      gravadoNoMomentoDoEnvio = (await repo.messages.getById(message.id))?.wa_message_id ?? null;
      return { key: { id: opts?.messageId ?? 'BAILEYS.X' } };
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    const r = await worker.processOutboxOnce();
    expect(r.sent).toBe(1);
    expect(idRecebidoPeloSocket).toBe('ID.RESERVADO.1'); // repassado à lib
    expect(gravadoNoMomentoDoEnvio).toBe('ID.RESERVADO.1'); // JÁ persistido
    const final = await repo.messages.getById(message.id);
    expect(final?.wa_message_id).toBe('ID.RESERVADO.1');
    expect(final?.status).toBe('sent');
    await worker.stop();
  });

  it('retry REUTILIZA o messageId (servidor deduplica; sem entrega dupla)', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const fake = makeFakeSocket();
    let n = 0;
    fake.socket.gerarMessageId = () => 'ID.GERADO.' + ++n;
    const idsVistos = [];
    fake.socket.sendMessage = async (_j, _c, opts) => {
      idsVistos.push(opts?.messageId);
      // 1ª tentativa: transitório (volta pra fila). 2ª: passa.
      if (idsVistos.length === 1) {
        throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
      }
      return { key: { id: opts?.messageId } };
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    expect((await worker.processOutboxOnce()).requeued).toBe(1);
    expect((await worker.processOutboxOnce()).sent).toBe(1);

    // MESMO id nas duas tentativas — não um id novo por tentativa.
    expect(idsVistos).toEqual(['ID.GERADO.1', 'ID.GERADO.1']);
    expect((await repo.messages.getById(message.id))?.wa_message_id).toBe('ID.GERADO.1');
    await worker.stop();
  });

  it('socket SEM gerarMessageId: comportamento antigo, mas AVISADO em warn', async () => {
    const avisos: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      avisos.push(a.join(' '));
    });
    try {
      const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
      const { worker } = await workerWithSocket(); // fake sem gerarMessageId

      expect((await worker.processOutboxOnce()).sent).toBe(1);
      expect((await repo.messages.getById(message.id))?.wa_message_id).toBe('BAILEYS.1');

      // A degradação NÃO pode ser muda: é a corrida com o eco voltando, e é
      // pré-condição da rodada do fromMe que este aviso nunca apareça.
      const aviso = avisos.find((l) => l.includes('SEM reserva de messageId'));
      expect(aviso).toBeTruthy();
      expect(aviso).toContain('NÃO aceite `fromMe`');
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('reserva prévia NÃO se disfarça de retry no log (e o retry continua avisando)', async () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      linhas.push(a.join(' '));
    });
    try {
      const fake = makeFakeSocket();
      fake.socket.gerarMessageId = () => 'ID.1';
      const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
      await worker.connectInstance(inst);

      // Caminho reativo: reserva prévia em TODA mensagem — nunca é retry.
      await sendViaProvider(
        repo, inst, { type: 'text', to: PHONE, text: 'do bot' }, worker.flowDeps(),
      );
      expect(linhas.filter((l) => l.includes('retry reutilizando'))).toHaveLength(0);

      // Primeiro envio pela outbox também não é retry.
      await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'do painel' });
      await worker.processOutboxOnce();
      expect(linhas.filter((l) => l.includes('retry reutilizando'))).toHaveLength(0);
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('fluxo reativo: linha criada ANTES do envio, já com o id reservado', async () => {
    const fake = makeFakeSocket();
    fake.socket.gerarMessageId = () => 'ID.REATIVO.1';
    let existiaNoMomentoDoEnvio = null;
    fake.socket.sendMessage = async (_j, _c, opts) => {
      existiaNoMomentoDoEnvio = await repo.messages.getByWaMessageId(inst.id, 'ID.REATIVO.1');
      return { key: { id: opts?.messageId } };
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    // Caminho reativo: sendViaProvider com o socketSender do worker.
    const { message } = await sendViaProvider(
      repo, inst, { type: 'text', to: PHONE, text: 'resposta do bot' }, worker.flowDeps(),
    );

    expect(existiaNoMomentoDoEnvio).not.toBeNull(); // já persistida
    expect(message.wa_message_id).toBe('ID.REATIVO.1');
    expect((await repo.messages.getById(message.id))?.status).toBe('sent');
    await worker.stop();
  });

  it('claim atômico: dois consumos simultâneos não enviam o mesmo item duas vezes', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'unico' });
    const { worker, fake } = await workerWithSocket();
    const [a, b] = await Promise.all([worker.processOutboxOnce(), worker.processOutboxOnce()]);
    expect(a.sent + b.sent).toBe(1);
    expect(fake.sent.length).toBe(1);
  });
});

describe('inbound em @lid — o bug que descartava TODA mensagem em silêncio', () => {
  const LID = '271828182845904@lid';

  function msgLid(alt?: string) {
    return {
      key: { remoteJid: LID, remoteJidAlt: alt, id: 'WLID' },
      pushName: 'Ana',
      message: { conversation: 'oi por lid' },
    };
  }

  it('resolverEnderecoInbound distingue PN, LID, grupo e desconhecido', () => {
    expect(resolverEnderecoInbound('5511999998888@s.whatsapp.net')).toEqual({
      tipo: 'pn', telefone: '5511999998888',
    });
    // O id do LID JAMAIS vira telefone: sem o Alt, fica sem número.
    expect(resolverEnderecoInbound(LID)).toEqual({ tipo: 'lid', telefone: null });
    expect(resolverEnderecoInbound(LID, '5511999998888@s.whatsapp.net')).toEqual({
      tipo: 'lid', telefone: '5511999998888',
    });
    // Telefone vindo do mapa LID→PN (3º argumento).
    expect(resolverEnderecoInbound(LID, null, '5511999998888@s.whatsapp.net')).toEqual({
      tipo: 'lid', telefone: '5511999998888',
    });
    expect(resolverEnderecoInbound('123-456@g.us').tipo).toBe('grupo');
    expect(resolverEnderecoInbound('algo@novo.servidor').tipo).toBe('desconhecido');
  });

  it('analisarInbound: @lid COM remoteJidAlt é aceito com o telefone real', () => {
    const r = analisarInbound(msgLid('5511999998888@s.whatsapp.net'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.endereco).toBe('lid');
    expect(r.dados.from).toBe('5511999998888');
    expect(r.dados.flowInput.text).toBe('oi por lid');
  });

  it('analisarInbound: @lid SEM telefone devolve o motivo (não um null mudo)', () => {
    const r = analisarInbound(msgLid());
    expect(r).toEqual({ ok: false, motivo: 'lid_sem_telefone', jid: LID });
  });

  it('analisarInbound: grupo e formato desconhecido têm motivos distintos', () => {
    expect(analisarInbound({ key: { remoteJid: '1@g.us' }, message: { conversation: 'x' } })).toMatchObject({
      ok: false, motivo: 'grupo',
    });
    expect(analisarInbound({ key: { remoteJid: 'x@futuro' }, message: { conversation: 'x' } })).toMatchObject({
      ok: false, motivo: 'jid_desconhecido',
    });
    expect(analisarInbound({ key: { remoteJid: '5511999998888@s.whatsapp.net' } })).toMatchObject({
      ok: false, motivo: 'sem_conteudo',
    });
  });

  it('GRAVA a mensagem quando o inbound chega em @lid (o caso de produção)', async () => {
    const fake = makeFakeSocket();
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);
    await repo.instances.update(inst.id, { own_number: '5521999243888' });
    const comNumero = (await repo.instances.getById(inst.id)) as Instance;

    await worker.handleIncoming(comNumero, msgLid('5511999998888@s.whatsapp.net'));

    const msgs = await repo.messages.listByContact(inst.id, '5511999998888');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('in');
    expect(msgs[0].from_number).toBe('5511999998888');
    expect(msgs[0].to_number).toBe('5521999243888'); // own_number, sem sentinela
    await worker.stop();
  });

  it('sem remoteJidAlt, usa o mapa LID→PN do socket (fallback confirmado na lib)', async () => {
    const fake = makeFakeSocket();
    const consultados: string[] = [];
    fake.socket.signalRepository = {
      lidMapping: {
        async getPNForLID(lid: string) {
          consultados.push(lid);
          return '5511777776666@s.whatsapp.net';
        },
      },
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await worker.handleIncoming(inst, msgLid()); // sem Alt

    expect(consultados).toEqual([LID]);
    const msgs = await repo.messages.listByContact(inst.id, '5511777776666');
    expect(msgs).toHaveLength(1);
    await worker.stop();
  });

  it('mapa indisponível ou sem resposta: descarta COM log, nunca em silêncio', async () => {
    const avisos: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      avisos.push(a.join(' '));
    });
    try {
      const fake = makeFakeSocket(); // sem signalRepository
      const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
      await worker.connectInstance(inst);

      await worker.handleIncoming(inst, msgLid());

      expect(await repo.messages.listByContact(inst.id, '5511999998888')).toHaveLength(0);
      const linha = avisos.find((l) => l.includes('inbound DESCARTADO'));
      expect(linha).toBeTruthy();
      expect(linha).toContain('motivo=lid_sem_telefone');
      expect(linha).toContain(LID); // o remoteJid CRU no log
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('inbound aceito gera log informativo com o telefone resolvido', async () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      linhas.push(a.join(' '));
    });
    try {
      const fake = makeFakeSocket();
      const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
      await worker.connectInstance(inst);

      await worker.handleIncoming(inst, {
        key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'WPN' },
        message: { conversation: 'oi' },
      });
      await worker.handleIncoming(inst, msgLid('5511999998888@s.whatsapp.net'));

      const pn = linhas.find((l) => l.includes('inbound aceito (pn)'));
      const lid = linhas.find((l) => l.includes('inbound aceito (lid)'));
      expect(pn).toContain(`telefone=${PHONE}`);
      expect(lid).toContain('telefone=5511999998888');
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('grupo continua ignorado (sem regressão) — e agora deixa rastro', async () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      linhas.push(a.join(' '));
    });
    try {
      const fake = makeFakeSocket();
      const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
      await worker.connectInstance(inst);

      await worker.handleIncoming(inst, {
        key: { remoteJid: '12345-67890@g.us', id: 'WG' },
        message: { conversation: 'mensagem de grupo' },
      });

      expect(await repo.messages.listByContact(inst.id, '1234567890')).toHaveLength(0);
      expect(linhas.find((l) => l.includes('motivo=grupo'))).toBeTruthy();
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('avatar do contato (worker busca, API só lê)', () => {
  function socketComFoto(url: string | undefined, erro?: Error) {
    const fake = makeFakeSocket();
    const chamadas: string[] = [];
    fake.socket.profilePictureUrl = async (jid: string) => {
      chamadas.push(jid);
      if (erro) throw erro;
      return url;
    };
    return { fake, chamadas };
  }

  async function comInbound(worker: BaileysWorker, id = 'W1') {
    await worker.handleIncoming(inst, {
      key: { remoteJid: PHONE + '@s.whatsapp.net', id },
      message: { conversation: 'oi' },
    });
  }

  it('busca e grava a foto na primeira mensagem do contato', async () => {
    const { fake, chamadas } = socketComFoto('https://cdn.wa/foto.jpg');
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await comInbound(worker);
    await new Promise((r) => setTimeout(r, 30)); // busca é não-bloqueante

    expect(chamadas).toEqual([PHONE + '@s.whatsapp.net']);
    const c = await repo.contacts.getByPhone(inst.id, PHONE);
    expect(c?.avatar_url).toBe('https://cdn.wa/foto.jpg');
    expect(c?.avatar_fetched_at).toBeTruthy();
    await worker.stop();
  });

  it('CACHE NEGATIVO: sem foto grava o carimbo e não repete a consulta', async () => {
    const { fake, chamadas } = socketComFoto(undefined); // contato sem foto
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await comInbound(worker, 'W1');
    await new Promise((r) => setTimeout(r, 30));
    const c1 = await repo.contacts.getByPhone(inst.id, PHONE);
    expect(c1?.avatar_url).toBeNull();
    expect(c1?.avatar_fetched_at).toBeTruthy(); // carimbo mesmo SEM foto

    // Segunda mensagem dentro do TTL: NÃO consulta de novo.
    await comInbound(worker, 'W2');
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas).toHaveLength(1);
    await worker.stop();
  });

  it('foto oculta por privacidade (lança) também vira cache negativo', async () => {
    const { fake } = socketComFoto(undefined, Object.assign(new Error('forbidden'), {
      output: { statusCode: 403 },
    }));
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await comInbound(worker);
    await new Promise((r) => setTimeout(r, 30));

    const c = await repo.contacts.getByPhone(inst.id, PHONE);
    expect(c?.avatar_url).toBeNull();
    expect(c?.avatar_fetched_at).toBeTruthy(); // não vai reconsultar a cada msg
    await worker.stop();
  });

  it('TTL vencido volta a consultar', async () => {
    const { fake, chamadas } = socketComFoto('https://cdn.wa/nova.jpg');
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => fake.socket,
      avatarTtlHours: 0, // tudo já vencido
      minProfileIntervalMs: 1,
    });
    await worker.connectInstance(inst);

    await comInbound(worker, 'W1');
    await new Promise((r) => setTimeout(r, 30));
    await comInbound(worker, 'W2');
    await new Promise((r) => setTimeout(r, 30));

    expect(chamadas.length).toBeGreaterThanOrEqual(2);
    await worker.stop();
  });

  it('falha na busca NÃO derruba nem atrasa a gravação da mensagem', async () => {
    const fake = makeFakeSocket();
    fake.socket.profilePictureUrl = async () => {
      throw new Error('rede fora');
    };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await comInbound(worker);
    // A mensagem está gravada mesmo com a busca de avatar falhando.
    expect(await repo.messages.listByContact(inst.id, PHONE)).toHaveLength(1);
    await worker.stop();
  });

  it('instância Meta: nenhuma consulta (socket sem profilePictureUrl)', async () => {
    const fake = makeFakeSocket(); // sem profilePictureUrl, como o caminho Meta
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);

    await comInbound(worker);
    await new Promise((r) => setTimeout(r, 20));

    const c = await repo.contacts.getByPhone(inst.id, PHONE);
    expect(c?.avatar_url).toBeNull();
    expect(c?.avatar_fetched_at).toBeNull(); // nem tentou
    await worker.stop();
  });

  it('listConversations devolve avatar_url (JOIN existente, sem N+1)', async () => {
    const { fake } = socketComFoto('https://cdn.wa/foto.jpg');
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);
    await comInbound(worker);
    await new Promise((r) => setTimeout(r, 30));

    const convs = await repo.messages.listConversations(inst.id);
    expect(convs[0].avatar_url).toBe('https://cdn.wa/foto.jpg');
    await worker.stop();
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

  it('open grava o número PRÓPRIO da instância e mata o sentinela (§3.5)', async () => {
    const fake = makeFakeSocket();
    fake.socket.user = { id: '5511988887777:12@s.whatsapp.net' };
    const worker = new BaileysWorker(repo, { socketFactory: async () => fake.socket });
    await worker.connectInstance(inst);
    expect((await repo.instances.getById(inst.id))?.own_number).toBeNull();

    await worker.handleConnectionUpdate(inst, { connection: 'open' });
    const salva = await repo.instances.getById(inst.id);
    expect(salva?.own_number).toBe('5511988887777'); // sem o sufixo :12
    expect(salva?.connection_status).toBe('connected');

    // Inbound depois do pareamento grava o número REAL como to_number.
    await worker.handleIncoming(inst, {
      key: { remoteJid: PHONE + '@s.whatsapp.net', id: 'WOWN' },
      message: { conversation: 'oi' },
    });
    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    const inbound = msgs.find((mm) => mm.wa_message_id === 'WOWN');
    expect(inbound?.to_number).toBe('5511988887777');
    expect(inbound?.to_number).not.toBe('000000000');
    await worker.stop();
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

describe('B3 — varredura periódica de instâncias', () => {
  /** Espera até a condição valer (ou estoura). Evita sleep fixo e flaky. */
  async function ate(cond: () => boolean, limiteMs = 500): Promise<void> {
    const fim = Date.now() + limiteMs;
    while (!cond() && Date.now() < fim) await new Promise((r) => setTimeout(r, 5));
  }

  it('instância criada DEPOIS do boot é detectada e ganha socket', async () => {
    const conectadas: string[] = [];
    const worker = new BaileysWorker(repo, {
      socketFactory: async (i) => {
        conectadas.push(i.id);
        return makeFakeSocket().socket;
      },
      pollMs: 10_000, // outbox fora do caminho deste teste
      scanMs: 20,
    });
    await worker.start();
    expect(conectadas).toEqual([inst.id]); // varredura do boot

    // Nasce uma instância nova com o worker JÁ no ar (o caso do B3).
    const nova = await repo.instances.create({
      org_id: 'org_default',
      name: 'Teste Rafael', provider_type: 'baileys', phone_number_id: null, waba_id: null,
      token: null, verify_token: null, active: true, connection_status: 'disconnected',
    });

    await ate(() => conectadas.includes(nova.id));
    expect(conectadas).toContain(nova.id);
    await worker.stop();
  });

  it('instância JÁ conectada não é tocada de novo (sem socket duplicado)', async () => {
    let aberturas = 0;
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => {
        aberturas++;
        return makeFakeSocket().socket;
      },
      pollMs: 10_000,
      scanMs: 5,
    });
    await worker.start();
    expect(aberturas).toBe(1);

    // Várias varreduras seguidas não podem reabrir o que já está aberto.
    await worker.scanInstancesOnce();
    await worker.scanInstancesOnce();
    await new Promise((r) => setTimeout(r, 40));
    expect(aberturas).toBe(1);
    await worker.stop();
  });

  it('instância em backoff de reconexão não ganha socket paralelo da varredura', async () => {
    let aberturas = 0;
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => {
        aberturas++;
        return makeFakeSocket().socket;
      },
      pollMs: 10_000,
      maxReconnectDelayMs: 60, // backoff longo o bastante p/ a varredura cair no meio
    });
    await worker.start();
    expect(aberturas).toBe(1);

    // Queda: socket sai do Map e a reconexão fica AGENDADA.
    await worker.handleConnectionUpdate(inst, {
      connection: 'close',
      lastDisconnect: { error: { message: 'Connection Lost', output: { statusCode: 428 } } },
    });
    // Varredura no meio do backoff: NÃO pode abrir um segundo socket.
    const r = await worker.scanInstancesOnce();
    expect(r.conectadas).toBe(0);
    expect(aberturas).toBe(1);

    // Passado o backoff, a reconexão agendada abre — uma vez só.
    await ate(() => aberturas === 2);
    expect(aberturas).toBe(2);
    await worker.stop();
  });

  it('instância desativada tem o socket fechado e NÃO reconecta sozinha', async () => {
    const fake = makeFakeSocket();
    let fechado = false;
    fake.socket.end = () => {
      fechado = true;
      // O Baileys emite o close DEPOIS do end() — é aqui que a versão sem a
      // marca de fechamento intencional reconectaria o que acabou de desligar.
      fake.emit('connection.update', { connection: 'close', lastDisconnect: undefined });
    };
    let aberturas = 0;
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => {
        aberturas++;
        return fake.socket;
      },
      pollMs: 10_000,
      maxReconnectDelayMs: 1,
    });
    await worker.start();
    expect(aberturas).toBe(1);

    await repo.instances.update(inst.id, { active: false });
    const r = await worker.scanInstancesOnce();

    expect(r.desconectadas).toBe(1);
    expect(fechado).toBe(true);
    expect((await repo.instances.getById(inst.id))?.connection_status).toBe('disconnected');

    // Nenhuma reconexão fantasma depois do fechamento intencional.
    await new Promise((r2) => setTimeout(r2, 40));
    expect(aberturas).toBe(1);
    await worker.stop();
  });
});

describe('B4 — outbox travada vira falha explícita (nunca some calada)', () => {
  // O item nasce "agora"; quem controla o que é velho é o limiar. `0` = tudo
  // que já existe está vencido (esperamos alguns ms para o corte ser > created_at);
  // `60` = nada recém-criado vence. Evita SQL cru só para envelhecer a linha.
  const JA_VENCIDO = 0;
  const UMA_HORA = 60;

  it('item vencido de instância SEM socket vira failed com motivo auditável', async () => {
    const { message } = await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => makeFakeSocket().socket,
      outboxStaleMinutes: JA_VENCIDO,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(await worker.failStaleOutbox(inst)).toBe(1);

    const failed = await repo.outbox.listByInstance(inst.id, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('instance_disconnected_timeout');

    // A mensagem ligada sai do "queued" eterno no Live Chat.
    const msgs = await repo.messages.listByContact(inst.id, PHONE);
    const msg = msgs.find((m) => m.id === message.id);
    expect(msg?.status).toBe('failed');
    expect(msg?.error_code).toBe('instance_disconnected_timeout');
    expect(msg?.error_message).toContain('Instância desconectada');
  });

  it('item recente NÃO é tocado', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => makeFakeSocket().socket,
      outboxStaleMinutes: UMA_HORA,
    });

    expect(await worker.failStaleOutbox(inst)).toBe(0);
    expect(await repo.outbox.listByInstance(inst.id, 'pending')).toHaveLength(1);
  });

  it('instância CONECTADA não sofre TTL, mesmo com item vencido', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => makeFakeSocket().socket,
      pollMs: 10_000, // o consumo normal fora do caminho deste teste
      outboxStaleMinutes: JA_VENCIDO,
    });
    await worker.start(); // instância ativa → ganha socket
    await new Promise((r) => setTimeout(r, 10));

    await worker.scanInstancesOnce(); // TTL só para quem NÃO tem socket
    expect(await repo.outbox.listByInstance(inst.id, 'pending')).toHaveLength(1);
    await worker.stop();
  });

  it('a varredura periódica aplica o TTL na instância desativada', async () => {
    await sendViaProvider(repo, inst, { type: 'text', to: PHONE, text: 'oi' });
    const worker = new BaileysWorker(repo, {
      socketFactory: async () => makeFakeSocket().socket,
      pollMs: 10_000,
      outboxStaleMinutes: JA_VENCIDO,
    });
    await worker.start();
    await repo.instances.update(inst.id, { active: false });
    await new Promise((r) => setTimeout(r, 10));

    await worker.scanInstancesOnce(); // fecha o socket E aplica o TTL
    const failed = await repo.outbox.listByInstance(inst.id, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('instance_disconnected_timeout');
    await worker.stop();
  });
});

describe('logger do Baileys — o detalhe que o pino default perdia', () => {
  const boom = Object.assign(new Error('Connection Closed'), {
    output: { statusCode: 428 },
  });

  function coletar(opts: Parameters<typeof makeBaileysLogger>[1] = {}) {
    const linhas: { level: string; linha: string }[] = [];
    const logger = makeBaileysLogger(inst, {
      ...opts,
      sink: (level, linha) => linhas.push({ level, linha }),
    });
    return { logger, linhas };
  }

  it('extractErro puxa message, statusCode e stack (campos `error` e `err`)', () => {
    expect(extractErro({ error: boom })).toMatchObject({
      message: 'Connection Closed',
      statusCode: 428,
    });
    expect(extractErro({ err: boom }).message).toBe('Connection Closed');
    expect(extractErro({}).message).toBeNull();
    expect(extractErro(undefined)).toEqual({ message: null, statusCode: null, stack: null });
  });

  it('error da lib sai COM message/statusCode/stack e a instância', () => {
    const { logger, linhas } = coletar({ level: 'warn' });
    // Exatamente como messages-recv.js:1436 chama.
    logger.error({ error: boom, node: '<message id="X"/>' }, 'error in handling message');

    expect(linhas).toHaveLength(1);
    expect(linhas[0].level).toBe('error');
    expect(linhas[0].linha).toContain('error in handling message');
    expect(linhas[0].linha).toContain('erro=Connection Closed');
    expect(linhas[0].linha).toContain('statusCode=428');
    expect(linhas[0].linha).toContain(inst.name);
    expect(linhas[0].linha).toContain(inst.id);
    expect(linhas[0].linha).toContain('Error: Connection Closed'); // stack
  });

  it('428 logo após fechamento NOSSO vira debug (ruído esperado, some em warn)', () => {
    const { logger, linhas } = coletar({ level: 'warn', intentionalClose: () => true });
    logger.error({ error: boom }, 'error in handling message');
    expect(linhas).toHaveLength(0); // rebaixado p/ debug e filtrado pelo nível

    // O mesmo erro SEM fechamento intencional continua aparecendo.
    const semFechamento = coletar({ level: 'warn', intentionalClose: () => false });
    semFechamento.logger.error({ error: boom }, 'error in handling message');
    expect(semFechamento.linhas).toHaveLength(1);
    expect(semFechamento.linhas[0].level).toBe('error');
  });

  it('nível default warn corta o ruído de info, mas nunca um erro real', () => {
    const { logger, linhas } = coletar({ level: 'warn' });
    logger.info({ node: {} }, 'connected to WA');
    logger.debug({}, 'sent ack');
    expect(linhas).toHaveLength(0);

    logger.error({ error: new Error('falha de verdade') }, 'boom');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].linha).toContain('erro=falha de verdade');
  });

  it('child() preserva a instância (o Baileys chama child({class:"baileys"}))', () => {
    const { logger, linhas } = coletar({ level: 'warn' });
    logger.child({ class: 'baileys' }).error({ error: boom }, 'erro no filho');
    expect(linhas[0].linha).toContain('class=baileys');
    expect(linhas[0].linha).toContain(inst.id);
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
