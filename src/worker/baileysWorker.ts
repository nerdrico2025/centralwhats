import type { Repo } from '../repo';
import type { Instance } from '../repo/types';
import { getProvider, type BaileysSendPayload, type BaileysSender, type SendResult } from '../providers';
import { recordInbound } from '../domain/inbound';
import { processPendingExecutions, type FlowDeps } from '../domain/flows';

/**
 * WORKER BAILEYS (V2 / P5.2) — processo SEMPRE-LIGADO (Railway/Fly/VPS).
 *
 * Mantém 1 socket por instância provider_type='baileys', grava inbound no
 * MESMO banco e chama o MESMO motor de fluxos do /domain (reuso total).
 * Consome a outbox para envios iniciados pela web; envios reativos (resposta
 * de fluxo) saem direto pelo socket.
 *
 * NOTA sobre setInterval/setTimeout: a proibição do CLAUDE.md vale para a
 * camada web SERVERLESS (processo morre entre requests). Aqui o processo é
 * longo-vivo POR DESENHO (é a razão de existir do worker) — timers são o
 * mecanismo correto de polling/backoff.
 */

/** Superfície mínima do socket Baileys que o worker usa (mockável em teste). */
export interface BaileysSocketLike {
  ev: { on(event: string, cb: (arg: never) => void): void };
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  end?(err?: Error): void;
}

export type SocketFactory = (instance: Instance) => Promise<BaileysSocketLike>;

export interface BaileysWorkerOpts {
  socketFactory: SocketFactory;
  /** Intervalo do consumo da outbox (ms). */
  pollMs?: number;
  /** Backoff máximo de reconexão (ms). */
  maxReconnectDelayMs?: number;
}

/** Telefone → JID do WhatsApp. */
export function toJid(phone: string): string {
  return phone.replace(/\D+/g, '') + '@s.whatsapp.net';
}

/**
 * Converte o payload normalizado (outbox/provider) no conteúdo do socket.
 * Botões/listas: o Baileys não tem o mesmo formato interativo da oficial —
 * viram texto com as opções enumeradas; a resposta roteia pelo TÍTULO
 * digitado (o engine já casa por título, além de id).
 */
export function toSocketContent(
  payload: BaileysSendPayload,
  jid: string,
): Record<string, unknown> {
  switch (payload.type) {
    case 'text':
      return { text: payload.text };
    case 'media': {
      const mm = payload.media;
      const source = mm.url ? { url: mm.url } : { url: '' };
      switch (mm.kind) {
        case 'image':
          return { image: source, ...(mm.caption ? { caption: mm.caption } : {}) };
        case 'video':
          return { video: source, ...(mm.caption ? { caption: mm.caption } : {}) };
        case 'audio':
          return { audio: source };
        case 'document':
          return {
            document: source,
            ...(mm.filename ? { fileName: mm.filename } : {}),
            ...(mm.caption ? { caption: mm.caption } : {}),
          };
      }
      break;
    }
    case 'buttons': {
      const options = payload.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
      return { text: `${payload.body}\n\n${options}` };
    }
    case 'list': {
      const lines: string[] = [payload.body];
      for (const s of payload.sections) {
        if (s.title) lines.push('', `*${s.title}*`);
        for (const r of s.rows) lines.push(`• ${r.title}`);
      }
      return { text: lines.join('\n') };
    }
    case 'reaction':
      return {
        react: {
          text: payload.emoji,
          key: { remoteJid: jid, id: payload.messageId, fromMe: false },
        },
      };
  }
  return { text: '' };
}

/** Reconectar? Só se NÃO foi logout (401 = sessão encerrada de propósito). */
export function shouldReconnect(lastDisconnect: unknown): boolean {
  const statusCode = (
    lastDisconnect as { error?: { output?: { statusCode?: number } } } | undefined
  )?.error?.output?.statusCode;
  return statusCode !== 401;
}

/**
 * 515 (`DisconnectReason.restartRequired`): logo após um pareamento bem
 * sucedido o WhatsApp MANDA reiniciar a conexão. É etapa do sucesso, não
 * queda — tratar como falha faz o painel exibir "desconectado" no instante
 * seguinte a um scan que deu certo.
 */
const RESTART_REQUIRED = 515;

/** O close é o reinício esperado do pós-pareamento? */
export function isRestartRequired(lastDisconnect: unknown): boolean {
  return (
    (lastDisconnect as { error?: { output?: { statusCode?: number } } } | undefined)?.error?.output
      ?.statusCode === RESTART_REQUIRED
  );
}

/**
 * Extrai a CAUSA REAL de um fechamento de conexão.
 *
 * POR QUÊ: o Baileys só loga "connection errored" (genérico) — o motivo mora
 * no Boom: `output.statusCode` (401 logout, 405 handshake rejeitado, 408
 * timeout, 428 fechada, 515 restart) e, em falhas de stream, `data.reason`.
 * Sem isto o diagnóstico vira adivinhação.
 */
export function describeDisconnect(lastDisconnect: unknown): {
  statusCode: number | null;
  reason: string | null;
  message: string | null;
} {
  const error = (
    lastDisconnect as
      | {
          error?: {
            message?: string;
            output?: { statusCode?: number };
            data?: { reason?: unknown };
          };
        }
      | undefined
  )?.error;
  const reason = error?.data?.reason;
  return {
    statusCode: error?.output?.statusCode ?? null,
    reason: reason != null ? String(reason) : null,
    message: error?.message ?? null,
  };
}

/** Forma mínima de mensagem inbound do Baileys que normalizamos. */
export interface BaileysInboundMessage {
  key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null };
  pushName?: string | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: { caption?: string | null; mimetype?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
    audioMessage?: object | null;
    documentMessage?: { fileName?: string | null; caption?: string | null } | null;
    buttonsResponseMessage?: {
      selectedButtonId?: string | null;
      selectedDisplayText?: string | null;
    } | null;
    listResponseMessage?: {
      title?: string | null;
      singleSelectReply?: { selectedRowId?: string | null } | null;
    } | null;
  } | null;
}

/** Normaliza um inbound do Baileys para o núcleo compartilhado. */
export function extractBaileysInbound(waMsg: BaileysInboundMessage): {
  waMessageId: string | null;
  from: string;
  type: string;
  content: unknown;
  profileName: string | null;
  flowInput: { text: string | null; replyId: string | null };
} | null {
  const jid = waMsg.key?.remoteJid ?? '';
  // Só conversas 1:1 (grupos estão fora de escopo).
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const from = jid.replace(/\D+/g, '');
  const msg = waMsg.message;
  if (!msg) return null;

  const base = {
    waMessageId: waMsg.key?.id ?? null,
    from,
    profileName: waMsg.pushName ?? null,
  };

  const text = msg.conversation ?? msg.extendedTextMessage?.text ?? null;
  if (text != null) {
    return { ...base, type: 'text', content: { body: text }, flowInput: { text, replyId: null } };
  }
  if (msg.buttonsResponseMessage) {
    const b = msg.buttonsResponseMessage;
    return {
      ...base,
      type: 'interactive',
      content: { kind: 'button_reply', id: b.selectedButtonId ?? null, title: b.selectedDisplayText ?? null },
      flowInput: { text: b.selectedDisplayText ?? null, replyId: b.selectedButtonId ?? null },
    };
  }
  if (msg.listResponseMessage) {
    const l = msg.listResponseMessage;
    return {
      ...base,
      type: 'interactive',
      content: { kind: 'list_reply', id: l.singleSelectReply?.selectedRowId ?? null, title: l.title ?? null },
      flowInput: { text: l.title ?? null, replyId: l.singleSelectReply?.selectedRowId ?? null },
    };
  }
  if (msg.imageMessage) {
    return { ...base, type: 'image', content: { caption: msg.imageMessage.caption ?? null }, flowInput: { text: null, replyId: null } };
  }
  if (msg.videoMessage) {
    return { ...base, type: 'video', content: { caption: msg.videoMessage.caption ?? null }, flowInput: { text: null, replyId: null } };
  }
  if (msg.audioMessage) {
    return { ...base, type: 'audio', content: {}, flowInput: { text: null, replyId: null } };
  }
  if (msg.documentMessage) {
    return {
      ...base,
      type: 'document',
      content: { filename: msg.documentMessage.fileName ?? null },
      flowInput: { text: null, replyId: null },
    };
  }
  return null; // protocolo/status — ignora
}

export class BaileysWorker {
  private sockets = new Map<string, BaileysSocketLike>();
  private reconnectAttempts = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly repo: Repo,
    private readonly opts: BaileysWorkerOpts,
  ) {}

  /** Sender reativo: envia DIRETO pelo socket vivo da instância. */
  socketSender(): BaileysSender {
    return {
      send: async (instance, to, payload): Promise<SendResult> => {
        const socket = this.sockets.get(instance.id);
        if (!socket) throw new Error(`Instância ${instance.id} sem socket conectado`);
        const jid = toJid(to);
        const res = await socket.sendMessage(jid, toSocketContent(payload, jid));
        return { waMessageId: res?.key?.id ?? null, status: 'sent' };
      },
    };
  }

  /** Deps do motor de fluxos DENTRO do worker: provider via socket. */
  flowDeps(): FlowDeps {
    return {
      providerFor: (instance) =>
        getProvider(instance, { baileysSender: this.socketSender() }),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    const instances = await this.repo.instances.listAll();
    for (const inst of instances) {
      if (inst.provider_type === 'baileys' && inst.active) {
        await this.connectInstance(inst);
      }
    }
    const pollMs = this.opts.pollMs ?? 2000;
    this.pollTimer = setInterval(() => {
      void this.processOutboxOnce().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[worker] erro no consumo da outbox:', err);
      });
    }, pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const socket of this.sockets.values()) socket.end?.();
    this.sockets.clear();
  }

  async connectInstance(instance: Instance): Promise<void> {
    const socket = await this.opts.socketFactory(instance);
    this.sockets.set(instance.id, socket);
    socket.ev.on('connection.update', ((update: {
      qr?: string;
      connection?: string;
      isNewLogin?: boolean;
      lastDisconnect?: unknown;
    }) => {
      void this.handleConnectionUpdate(instance, update).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[worker] connection.update:', err);
      });
    }) as never);
    socket.ev.on('messages.upsert', ((u: { messages?: BaileysInboundMessage[] }) => {
      for (const msg of u.messages ?? []) {
        if (msg.key?.fromMe) continue;
        void this.handleIncoming(instance, msg).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[worker] inbound:', err);
        });
      }
    }) as never);
  }

  /** QR/conexão: reflete em connection_status e persiste o QR pro painel. */
  async handleConnectionUpdate(
    instance: Instance,
    update: {
      qr?: string;
      connection?: string;
      isNewLogin?: boolean;
      lastDisconnect?: unknown;
    },
  ): Promise<void> {
    if (update.qr) {
      await this.repo.baileysAuth.set(instance.id, 'qr', update.qr);
      await this.repo.instances.update(instance.id, { connection_status: 'pending' });
    }
    if (update.isNewLogin) {
      // "QR aceito": o pareamento foi confirmado, mas ainda falta o reinício
      // (515) + novo handshake até o 'open'. Sem este estado o painel fica
      // ~5-8s dizendo "desconectado" logo depois de um scan que deu certo.
      await this.repo.baileysAuth.delete(instance.id, 'qr');
      await this.repo.instances.update(instance.id, { connection_status: 'connecting' });
    }
    if (update.connection === 'open') {
      await this.repo.baileysAuth.delete(instance.id, 'qr');
      await this.repo.instances.update(instance.id, { connection_status: 'connected' });
      this.reconnectAttempts.set(instance.id, 0);
    }
    if (update.connection === 'close') {
      const causa = describeDisconnect(update.lastDisconnect);
      const reinicio = isRestartRequired(update.lastDisconnect);
      // eslint-disable-next-line no-console
      console.warn(
        `[worker] conexão fechada — instância=${instance.id} (${instance.name}) ` +
          `statusCode=${causa.statusCode ?? '-'} reason=${causa.reason ?? '-'} ` +
          `message=${causa.message ?? '-'}` +
          (reinicio ? ' (reinício esperado do pós-pareamento)' : ''),
      );
      await this.repo.instances.update(instance.id, {
        connection_status: reinicio ? 'connecting' : 'disconnected',
      });
      // O QR morre junto com o socket que o gerou (o `ref` é daquela conexão),
      // então NUNCA sobrevive a um close: mantê-lo faria o painel exibir um
      // código que jamais vai parear, sem nenhum indício de que está morto.
      await this.repo.baileysAuth.delete(instance.id, 'qr');
      this.sockets.delete(instance.id);
      if (reinicio) {
        // Reconexão de SUCESSO, não de falha: zera o backoff acumulado (QR que
        // expirou antes do scan podia ter empurrado a espera para 8s, 16s…).
        // Só aqui — falha real continua escalando como antes.
        this.reconnectAttempts.set(instance.id, 0);
      }
      if (!this.stopped && shouldReconnect(update.lastDisconnect)) {
        // Reconexão com backoff exponencial (1s, 2s, 4s... teto configurável).
        const attempt = (this.reconnectAttempts.get(instance.id) ?? 0) + 1;
        this.reconnectAttempts.set(instance.id, attempt);
        const delay = Math.min(
          1000 * 2 ** (attempt - 1),
          this.opts.maxReconnectDelayMs ?? 60000,
        );
        setTimeout(() => {
          void this.connectInstance(instance).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[worker] reconexão falhou:', err);
          });
        }, delay);
      } else if (!shouldReconnect(update.lastDisconnect)) {
        // Logout de verdade: limpa a sessão para permitir novo pareamento.
        await this.repo.baileysAuth.clear(instance.id);
      }
    }
  }

  /** Inbound do socket → MESMO núcleo do webhook (contato, CRM, msg, fluxos). */
  async handleIncoming(instance: Instance, waMsg: BaileysInboundMessage): Promise<void> {
    const normalized = extractBaileysInbound(waMsg);
    if (!normalized) return;
    await recordInbound(
      this.repo,
      instance,
      { ...normalized, toNumber: instance.phone_number_id ?? '000000000' },
      this.flowDeps(),
    );
    // Mesmo gancho da web: inbound dispara a varredura de retomadas.
    await processPendingExecutions(this.repo, instance.id, this.flowDeps());
  }

  /**
   * Consome a outbox das instâncias conectadas: claim atômico → envia pelo
   * socket → confirma no registro pré-logado em messages (queued→sent).
   * TODO resultado fica registrado (sucesso E falha) — nada se perde.
   */
  async processOutboxOnce(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const [instanceId, socket] of this.sockets) {
      const items = await this.repo.outbox.claimPending(instanceId, 10);
      for (const item of items) {
        const jid = toJid(item.to_number);
        try {
          const res = await socket.sendMessage(
            jid,
            toSocketContent(item.payload as BaileysSendPayload, jid),
          );
          await this.repo.outbox.markSent(item.id);
          if (item.message_id) {
            await this.repo.messages.updateById(item.message_id, {
              status: 'sent',
              wa_message_id: res?.key?.id ?? null,
            });
          }
          sent++;
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          await this.repo.outbox.markFailed(item.id, message);
          if (item.message_id) {
            await this.repo.messages.updateById(item.message_id, {
              status: 'failed',
              error_code: null,
              error_message: message,
            });
          }
          failed++;
        }
      }
    }
    return { sent, failed };
  }
}
