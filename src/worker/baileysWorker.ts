import type { Repo } from '../repo';
import type { Instance } from '../repo/types';
import { getProvider, type BaileysSendPayload, type BaileysSender, type SendResult } from '../providers';
import { recordInbound } from '../domain/inbound';
import { processPendingExecutions, type FlowDeps } from '../domain/flows';
import { classifySendError, descreverErroDeEnvio } from '../providers/classifySendError';

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
  /**
   * `creds.me` do Baileys (getter `user` do socket). Só existe DEPOIS do
   * pareamento; é daqui que sai o número próprio da instância (§3.5).
   */
  user?: { id?: string | null } | null;
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  end?(err?: Error): void;
}

/** Contexto que o worker dá à factory (o socket real usa no logger). */
export interface SocketContext {
  /** Este fechamento foi pedido por nós? Ver o Set `closing`. */
  intentionalClose(): boolean;
}

export type SocketFactory = (
  instance: Instance,
  ctx: SocketContext,
) => Promise<BaileysSocketLike>;

export interface BaileysWorkerOpts {
  socketFactory: SocketFactory;
  /** Intervalo do consumo da outbox (ms). */
  pollMs?: number;
  /** Intervalo da varredura de instâncias (ms). */
  scanMs?: number;
  /** TTL da outbox de instância sem socket (min). */
  outboxStaleMinutes?: number;
  /** Intervalo mínimo entre envios da MESMA instância (ms). */
  minSendIntervalMs?: number;
  /** Backoff máximo de reconexão (ms). */
  maxReconnectDelayMs?: number;
}

/**
 * Intervalo da varredura de instâncias, em segundos (default 30).
 * Configurável por env WORKER_SCAN_INTERVAL_S.
 */
export const SCAN_INTERVAL_S = Number(process.env.WORKER_SCAN_INTERVAL_S ?? 30);

/**
 * B4 — quanto tempo um item pode ficar `pending` numa instância SEM socket
 * antes de virar falha explícita (default 60min).
 * Configurável por env OUTBOX_STALE_MINUTES.
 */
export const OUTBOX_STALE_MINUTES = Number(process.env.OUTBOX_STALE_MINUTES ?? 60);

/** Motivo gravado em outbox.error e messages.error_code (auditável). */
export const OUTBOX_STALE_REASON = 'instance_disconnected_timeout';

/**
 * THROTTLE DE ENVIO BAILEYS — intervalo mínimo entre dois envios da MESMA
 * instância, em ms (default 1000). Configurável por env
 * BAILEYS_MIN_SEND_INTERVAL_MS.
 *
 * POR QUE EXISTE: o WhatsApp Web não devolve rate-limit por mensagem (ver
 * classifySendError). Excesso de envio não vira erro retentável — vira queda
 * de conexão e, no limite, logout/bloqueio do número. Contra isso, retry não
 * serve: o remédio é não mandar rápido demais na origem.
 *
 * POR QUE 1000ms: NÃO é medição — é ponto de partida conservador. Dois
 * motivos: (a) é ordens de grandeza mais lento que o comportamento anterior,
 * em que um lote de 10 saía tão rápido quanto o socket aceitasse; (b) é o
 * mesmo default que o projeto já considera razoável para envio em série no
 * caminho Meta (campaigns.interval_ms DEFAULT 1000). Se um dia houver medição
 * real do que o número aguenta, este é o botão para girar.
 */
export const BAILEYS_MIN_SEND_INTERVAL_MS = Number(
  process.env.BAILEYS_MIN_SEND_INTERVAL_MS ?? 1000,
);

/** Telefone → JID do WhatsApp. */
export function toJid(phone: string): string {
  return phone.replace(/\D+/g, '') + '@s.whatsapp.net';
}

/**
 * JID do próprio aparelho → telefone (§3.5).
 *
 * O Baileys entrega `creds.me.id` no formato `5511999998888:12@s.whatsapp.net`
 * — número, sufixo de DISPOSITIVO e domínio. Só os dígitos antes do `:`
 * interessam; o `:12` é o índice do aparelho pareado e muda a cada
 * re-pareamento, então gravá-lo faria o mesmo número parecer dois.
 */
export function ownNumberFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split(':')[0].split('@')[0].replace(/\D+/g, '');
  return digits.length >= 8 ? digits : null;
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
  /** Aberturas EM VOO ou agendadas (backoff). Evita socket duplicado. */
  private connecting = new Set<string>();
  /** Fechamentos INTENCIONAIS (instância desativada/removida): não reconectar. */
  private closing = new Set<string>();
  /**
   * Throttle POR INSTÂNCIA (§throttle): instante do último envio e a fila que
   * serializa os envios daquele número.
   *
   * ONDE MORA O ESTADO — memória do worker, e por quê: o worker é processo
   * SEMPRE-LIGADO e o projeto trava "uma réplica, sempre" (L6/D10 do
   * 03_MULTITENANCY_E_V2.md — duas réplicas já brigariam pelo socket, muito
   * antes de brigarem pelo throttle). Sob essa premissa, memória é a resposta
   * certa: custo zero, sem corrida, sem ida ao banco no caminho de envio.
   *
   * ⚠️ A SEGURANÇA DISTO DEPENDE DA CONVENÇÃO "UMA RÉPLICA" CONTINUAR VALENDO.
   * Escalar o worker horizontalmente SEM revisar este ponto quebra o throttle
   * em silêncio: cada processo teria o próprio `ultimoEnvioAt`, e N réplicas
   * multiplicariam por N a taxa de envio do MESMO número — exatamente o risco
   * de bloqueio que este mecanismo existe para evitar, e sem nenhum sinal de
   * que parou de funcionar. Quem mexer em escala do worker mexe aqui também.
   *
   * Se um dia houver mais de uma réplica, o desenho correto já está decidido
   * (partição por instância com lock) — e este mapa vira responsabilidade do
   * dono da partição, não estado global a sincronizar.
   *
   * Chave = instance_id, nunca global: cada instância é um número diferente,
   * com risco próprio. Uma não pode atrasar a outra.
   */
  private ultimoEnvioAt = new Map<string, number>();
  private filaDeEnvio = new Map<string, Promise<unknown>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;

  constructor(
    private readonly repo: Repo,
    private readonly opts: BaileysWorkerOpts,
  ) {}

  /**
   * PORTÃO ÚNICO de envio pelo socket — todo envio Baileys passa por aqui.
   *
   * POR QUE UM PORTÃO SÓ: o worker envia por DOIS caminhos (consumo da outbox
   * e resposta reativa de fluxo, que NÃO passa pela outbox — vai direto ao
   * socket). Throttle só na outbox deixaria de fora justamente a rajada de
   * bot: um fluxo com vários nós "Mensagem" dispara em sequência imediata.
   *
   * A fila por instância serializa os envios daquele número: sem ela, o
   * consumo da outbox e uma resposta de fluxo poderiam ler o mesmo
   * "último envio" e sair juntos, furando o intervalo.
   */
  private async enviarComThrottle(
    instanceId: string,
    socket: BaileysSocketLike,
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } } | undefined> {
    const intervalo = this.opts.minSendIntervalMs ?? BAILEYS_MIN_SEND_INTERVAL_MS;
    const anterior = this.filaDeEnvio.get(instanceId) ?? Promise.resolve();

    const atual = anterior
      .catch(() => undefined) // falha do envio anterior não trava a fila
      .then(async () => {
        const desde = Date.now() - (this.ultimoEnvioAt.get(instanceId) ?? 0);
        const espera = Math.max(0, intervalo - desde);
        if (espera > 0) {
          // Atraso NUNCA é invisível: sem esta linha, "a fila está lenta"
          // viraria mistério em produção.
          // eslint-disable-next-line no-console
          console.log(
            `[worker] throttle: aguardando ${espera}ms antes do próximo envio ` +
              `da instância ${instanceId} (mínimo ${intervalo}ms entre envios)`,
          );
          await new Promise((r) => setTimeout(r, espera));
        }
        this.ultimoEnvioAt.set(instanceId, Date.now());
        return socket.sendMessage(jid, content);
      });

    // A fila guarda a versão "que nunca rejeita", para um envio com erro não
    // derrubar os próximos da mesma instância.
    this.filaDeEnvio.set(
      instanceId,
      atual.catch(() => undefined),
    );
    return atual;
  }

  /** Sender reativo: envia DIRETO pelo socket vivo da instância (com throttle). */
  socketSender(): BaileysSender {
    return {
      send: async (instance, to, payload): Promise<SendResult> => {
        const socket = this.sockets.get(instance.id);
        if (!socket) throw new Error(`Instância ${instance.id} sem socket conectado`);
        const jid = toJid(to);
        const res = await this.enviarComThrottle(
          instance.id,
          socket,
          jid,
          toSocketContent(payload, jid),
        );
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
    // Varredura do boot: MESMO caminho da periódica (nada duplicado aqui).
    await this.scanInstancesOnce();

    const pollMs = this.opts.pollMs ?? 2000;
    this.pollTimer = setInterval(() => {
      void this.processOutboxOnce().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[worker] erro no consumo da outbox:', err);
      });
    }, pollMs);

    // B3: sem isto, instância criada DEPOIS do boot nunca ganha socket e o
    // QR fica vazio até alguém reiniciar o serviço na mão. Timer é legítimo
    // aqui — este processo é longo-vivo por desenho (ver nota no topo).
    const scanMs = this.opts.scanMs ?? SCAN_INTERVAL_S * 1000;
    this.scanTimer = setInterval(() => {
      void this.scanInstancesOnce().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[worker] erro na varredura de instâncias:', err);
      });
    }, scanMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const socket of this.sockets.values()) socket.end?.();
    this.sockets.clear();
  }

  /**
   * Varredura de instâncias: abre socket para toda Baileys ativa que ainda
   * não tem um, e fecha o socket das que saíram do ar (desativadas/removidas).
   *
   * Roda no boot E periodicamente. Uma varredura nunca atropela a outra
   * (`scanning`), e instâncias com abertura em voo ou aguardando backoff são
   * puladas (`connecting`) — senão a varredura abriria um socket paralelo
   * para quem já está reconectando.
   */
  async scanInstancesOnce(): Promise<{ conectadas: number; desconectadas: number }> {
    if (this.scanning || this.stopped) return { conectadas: 0, desconectadas: 0 };
    this.scanning = true;
    let conectadas = 0;
    let desconectadas = 0;
    try {
      const instances = await this.repo.instances.listAll();
      const ativas = new Set<string>();

      for (const inst of instances) {
        if (inst.provider_type !== 'baileys' || !inst.active) continue;
        ativas.add(inst.id);
        if (this.sockets.has(inst.id) || this.connecting.has(inst.id)) continue;
        // eslint-disable-next-line no-console
        console.log(
          `[worker] instância nova detectada, abrindo socket: ${inst.name} (${inst.id})`,
        );
        await this.connectInstance(inst);
        conectadas++;
      }

      // Sumiu da lista de ativas (active=false ou deletada) mas o socket
      // continua aberto: recebendo mensagem e rodando fluxo de uma instância
      // que o painel considera desligada. Fecha.
      for (const id of [...this.sockets.keys()]) {
        if (ativas.has(id)) continue;
        // eslint-disable-next-line no-console
        console.log(`[worker] instância desativada/removida, fechando socket: ${id}`);
        await this.disconnectInstance(id);
        desconectadas++;
      }

      // B4: instância sem socket não consome outbox. Sem isto, a fila cresce
      // calada até um cliente reclamar que não recebeu nada.
      for (const inst of instances) {
        if (this.sockets.has(inst.id)) continue;
        await this.failStaleOutbox(inst);
      }
    } finally {
      this.scanning = false;
    }
    return { conectadas, desconectadas };
  }

  /**
   * B4 — TTL da outbox de instância SEM socket.
   *
   * POR QUÊ o limiar é generoso (60min default): a outbox de instância viva é
   * drenada a cada 2s e o backoff de reconexão tem teto de 60s. Um item parado
   * há uma hora não é lentidão — é número morto. Curto demais transformaria
   * queda passageira em mensagem perdida.
   *
   * POR QUÊ só quem não tem socket: com socket vivo o poll leva o item em
   * segundos; marcar falha ali seria roubar trabalho de quem ia fazê-lo.
   *
   * Nada some em silêncio: o item vira `failed` COM motivo e a mensagem
   * ligada a ele também, para o Live Chat parar de mostrar "queued" eterno.
   */
  async failStaleOutbox(instance: Instance): Promise<number> {
    const limiteMin = this.opts.outboxStaleMinutes ?? OUTBOX_STALE_MINUTES;
    const corte = Date.now() - limiteMin * 60_000;
    // listByInstance basta: só olhamos instâncias PARADAS, cuja fila não cresce.
    const pendentes = await this.repo.outbox.listByInstance(instance.id, 'pending');
    const travados = pendentes.filter((item) => {
      const criado = Date.parse(item.created_at);
      return Number.isFinite(criado) && criado < corte;
    });
    if (!travados.length) return 0;

    // eslint-disable-next-line no-console
    console.warn(
      `[worker] outbox travada, marcando como falha: ${travados.length} mensagens ` +
        `da instância ${instance.name} (${instance.id}), pending há mais de ${limiteMin}min`,
    );
    for (const item of travados) {
      await this.repo.outbox.markFailed(item.id, OUTBOX_STALE_REASON);
      if (item.message_id) {
        await this.repo.messages.updateById(item.message_id, {
          status: 'failed',
          error_code: OUTBOX_STALE_REASON,
          error_message: `Instância desconectada: mensagem ficou ${limiteMin}min na fila sem envio.`,
        });
      }
    }
    return travados.length;
  }

  /**
   * Fecha o socket de uma instância POR DECISÃO NOSSA (não é queda).
   * O id fica em `closing` até alguém reabrir: o `close` que o socket emite
   * chega depois, e sem essa marca o handler o trataria como queda e
   * reconectaria justamente o que acabamos de desligar.
   */
  async disconnectInstance(instanceId: string): Promise<void> {
    const socket = this.sockets.get(instanceId);
    this.sockets.delete(instanceId);
    this.closing.add(instanceId);
    try {
      socket?.end?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[worker] erro ao fechar socket:', (err as Error).message);
    }
    // A instância pode ter sido DELETADA — update em linha inexistente é no-op
    // nos dois adapters, então não precisa de checagem prévia.
    await this.repo.instances.update(instanceId, { connection_status: 'disconnected' });
  }

  async connectInstance(instance: Instance): Promise<void> {
    // Marca ANTES do await: a factory demora (rede), e sem isto uma varredura
    // que caísse no meio veria a instância "sem socket" e abriria um segundo.
    this.connecting.add(instance.id);
    this.closing.delete(instance.id);
    let socket: BaileysSocketLike;
    try {
      socket = await this.opts.socketFactory(instance, {
        intentionalClose: () => this.closing.has(instance.id),
      });
    } finally {
      // Falhou? Sai de `connecting` e a próxima varredura tenta de novo.
      this.connecting.delete(instance.id);
    }
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
          // Instância e id da mensagem no log: com várias instâncias no mesmo
          // worker, um stack solto não diz de qual número veio a falha.
          // eslint-disable-next-line no-console
          console.error(
            `[worker] inbound falhou — instância=${instance.id} (${instance.name}) ` +
              `msg=${msg.key?.id ?? '-'}:`,
            err,
          );
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
      // §3.5 — o número PRÓPRIO da instância só existe depois do pareamento, e
      // o socket é quem o conhece (`creds.me.id`). Gravar aqui é o que tira o
      // sentinela '000000000' do inbound e o from_number vazio do outbound.
      // Grava só quando MUDA: reconexão não precisa escrever no banco.
      const proprio = ownNumberFromJid(this.sockets.get(instance.id)?.user?.id);
      const patch: Partial<Instance> = { connection_status: 'connected' };
      if (proprio && proprio !== instance.own_number) {
        patch.own_number = proprio;
        instance.own_number = proprio; // a referência viva também aprende
        // eslint-disable-next-line no-console
        console.log(
          `[worker] número próprio da instância ${instance.name} (${instance.id}): ${proprio}`,
        );
      }
      await this.repo.instances.update(instance.id, patch);
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
      // Fechamento que NÓS pedimos (worker parando, instância desativada) não
      // é queda: reconectar aqui religaria justamente o que foi desligado.
      const intencional = this.stopped || this.closing.has(instance.id);
      if (!intencional && shouldReconnect(update.lastDisconnect)) {
        // Reconexão com backoff exponencial (1s, 2s, 4s... teto configurável).
        const attempt = (this.reconnectAttempts.get(instance.id) ?? 0) + 1;
        this.reconnectAttempts.set(instance.id, attempt);
        const delay = Math.min(
          1000 * 2 ** (attempt - 1),
          this.opts.maxReconnectDelayMs ?? 60000,
        );
        // A instância fica "em voo" durante o backoff — a varredura não pode
        // achar que ela está sem socket e abrir um paralelo.
        this.connecting.add(instance.id);
        setTimeout(() => {
          void this.connectInstance(instance).catch((err) => {
            // connectInstance já tirou de `connecting` no finally dele.
            // eslint-disable-next-line no-console
            console.error('[worker] reconexão falhou:', err);
          });
        }, delay);
      } else if (!intencional && !shouldReconnect(update.lastDisconnect)) {
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
      {
        ...normalized,
        // Numa mensagem RECEBIDA, `to_number` é o número da EMPRESA — ou seja,
        // o número desta instância. `own_number` é preenchido no 'open'.
        //
        // JANELA DE TRANSIÇÃO: instância pareada antes da migration 014 (ou
        // que ainda não reconectou) tem own_number nulo. O sentinela só existe
        // para esse intervalo, e some na primeira reconexão — sem ele, a
        // gravação falharia no normalizePhone e a mensagem recebida se perderia,
        // que é bem pior do que um número-marcador no histórico.
        toNumber: instance.own_number ?? instance.phone_number_id ?? '000000000',
      },
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
  async processOutboxOnce(): Promise<{ sent: number; failed: number; requeued: number }> {
    let sent = 0;
    let failed = 0;
    let requeued = 0;
    for (const [instanceId, socket] of this.sockets) {
      const items = await this.repo.outbox.claimPending(instanceId, 10);
      for (const item of items) {
        const jid = toJid(item.to_number);
        try {
          // MESMO portão do envio reativo: o intervalo mínimo vale para o
          // número, não para o caminho por onde a mensagem chegou.
          const res = await this.enviarComThrottle(
            instanceId,
            socket,
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
          // Classificação agnóstica (§3.5): antes disto TODA falha virava
          // `error_code: null` e `failed` definitivo — um blip de socket
          // matava a mensagem tão permanentemente quanto um número inválido.
          const cls = classifySendError(err, 'baileys');

          // Transitório volta para a fila. O teto NÃO é contagem (a outbox não
          // guarda tentativas) e sim IDADE: failStaleOutbox marca como falha o
          // que passar de OUTBOX_STALE_MINUTES. Sem isso, um erro transitório
          // eterno giraria para sempre a cada poll.
          const idadeMin = (Date.now() - Date.parse(item.created_at)) / 60_000;
          const limite = this.opts.outboxStaleMinutes ?? OUTBOX_STALE_MINUTES;
          if (cls.retryable && Number.isFinite(idadeMin) && idadeMin < limite) {
            await this.repo.outbox.requeue(item.id, `${cls.kind}: ${cls.message}`);
            // eslint-disable-next-line no-console
            console.warn(
              `[worker] envio devolvido à fila — instância=${instanceId} item=${item.id} ` +
                descreverErroDeEnvio(cls),
            );
            requeued++;
            continue;
          }

          if (cls.kind === 'unknown') {
            // Erro não mapeado nunca passa calado — é assim que a tabela de
            // classificação aprende um caso novo.
            // eslint-disable-next-line no-console
            console.error(
              `[worker] envio falhou SEM classificação — instância=${instanceId} ` +
                `item=${item.id} ${descreverErroDeEnvio(cls)}`,
            );
          }
          const motivo = `${cls.raw_code ?? cls.kind}: ${cls.message}`;
          await this.repo.outbox.markFailed(item.id, motivo);
          if (item.message_id) {
            await this.repo.messages.updateById(item.message_id, {
              status: 'failed',
              // Nunca null: o histórico sempre diz algo sobre o motivo.
              error_code: cls.raw_code ?? cls.kind,
              error_message: cls.message,
            });
          }
          failed++;
        }
      }
    }
    return { sent, failed, requeued };
  }
}
