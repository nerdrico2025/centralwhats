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
  /**
   * Mapa LID→PN da própria lib (socket.js:927). É o fallback quando um inbound
   * em `@lid` chega sem `remoteJidAlt`.
   */
  signalRepository?: {
    lidMapping?: { getPNForLID(lid: string): Promise<string | null> };
  } | null;
  /** Foto de perfil (Socket/chats.d.ts:40). `undefined` = sem foto. */
  profilePictureUrl?(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>;
  /** [DIAGNÓSTICO TEMPORÁRIO] privacidade da conta (Socket/chats.d.ts:33). */
  fetchPrivacySettings?(force?: boolean): Promise<unknown>;
  /**
   * Gera um id de mensagem no MESMO formato que a lib usaria
   * (generateMessageIDV2(sock.user?.id) — messages-send.js:1086). Fornecido
   * pela factory real; o worker nunca importa o Baileys direto.
   */
  gerarMessageId?(): string;
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    /** `messageId` pré-reservado; a lib o usa no lugar de gerar um. */
    opts?: { messageId?: string },
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
  /** TTL do avatar do contato (horas). */
  avatarTtlHours?: number;
  /** Intervalo mínimo entre consultas de foto de perfil (ms). */
  minProfileIntervalMs?: number;
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

/**
 * TTL do avatar do contato, em horas (default 24).
 * Configurável por env AVATAR_TTL_HOURS.
 */
export const AVATAR_TTL_HOURS = Number(process.env.AVATAR_TTL_HOURS ?? 24);

/**
 * Intervalo mínimo entre duas consultas de FOTO DE PERFIL da mesma instância
 * (default 2000ms). Configurável por env BAILEYS_MIN_PROFILE_INTERVAL_MS.
 *
 * Mais lento que o throttle de envio de propósito: buscar avatar é acessório,
 * e uma conversa nova por mensagem já é raro. O risco a evitar é o mesmo —
 * rajada de consultas ao WhatsApp a partir de um mesmo número.
 */
export const BAILEYS_MIN_PROFILE_INTERVAL_MS = Number(
  process.env.BAILEYS_MIN_PROFILE_INTERVAL_MS ?? 2000,
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
  key?: {
    remoteJid?: string | null;
    /** Telefone real quando `remoteJid` vem em `@lid` (decode-wa-message.js:180). */
    remoteJidAlt?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
  };
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

/** Inbound normalizado, pronto para o núcleo compartilhado. */
export interface InboundNormalizado {
  waMessageId: string | null;
  from: string;
  type: string;
  content: unknown;
  profileName: string | null;
  flowInput: { text: string | null; replyId: string | null };
}

/** Por que um inbound foi descartado — vira log, NUNCA silêncio. */
export type MotivoDescarte =
  | 'grupo'
  | 'jid_desconhecido'
  | 'lid_sem_telefone'
  | 'sem_conteudo'
  | 'tipo_nao_suportado';

export type AnaliseInbound =
  | { ok: true; dados: InboundNormalizado; endereco: 'pn' | 'lid' }
  | { ok: false; motivo: MotivoDescarte; jid: string };

/**
 * ENDEREÇAMENTO DE UMA CONVERSA 1:1 (bug real de produção).
 *
 * O WhatsApp tem DOIS jeitos de endereçar a mesma pessoa:
 *   - PN  — `5511999998888@s.whatsapp.net`, o telefone no próprio jid;
 *   - LID — `123456789@lid`, um identificador OPACO. O telefone não está ali:
 *     vem em `key.remoteJidAlt` (decode-wa-message.js:179-180) ou no mapa
 *     LID→PN que a lib mantém.
 *
 * Aceitar só PN fazia TODA mensagem de conta em LID ser descartada — e, como o
 * descarte era mudo, nenhuma instância Baileys jamais gravou um inbound em
 * produção sem que ninguém percebesse. Grupos (`@g.us`) seguem fora de escopo.
 */
export function resolverEnderecoInbound(
  jid: string,
  remoteJidAlt?: string | null,
  /** Telefone já resolvido pelo mapa LID→PN (o worker faz esse passo, que é async). */
  telefoneResolvido?: string | null,
): { tipo: 'pn' | 'lid' | 'grupo' | 'desconhecido'; telefone: string | null } {
  if (jid.endsWith('@g.us')) return { tipo: 'grupo', telefone: null };
  if (jid.endsWith('@s.whatsapp.net')) {
    return { tipo: 'pn', telefone: soDigitos(jid) };
  }
  if (jid.endsWith('@lid')) {
    // Ordem: o Alt do próprio payload, depois o que o mapa resolveu. O id do
    // LID JAMAIS vira telefone — seria gravar um número inventado no histórico.
    const doAlt = remoteJidAlt?.endsWith('@s.whatsapp.net') ? soDigitos(remoteJidAlt) : null;
    return { tipo: 'lid', telefone: doAlt ?? (telefoneResolvido ? soDigitos(telefoneResolvido) : null) };
  }
  return { tipo: 'desconhecido', telefone: null };
}

/** Dígitos antes do sufixo de dispositivo/domínio (`:12@servidor`). */
function soDigitos(jid: string): string {
  return jid.split(':')[0].split('@')[0].replace(/\D+/g, '');
}

/**
 * Analisa um inbound e diz OU os dados normalizados OU o motivo do descarte.
 * Nada aqui devolve `null` mudo: quem chama sempre tem o que logar.
 */
export function analisarInbound(
  waMsg: BaileysInboundMessage,
  telefoneResolvido?: string | null,
): AnaliseInbound {
  const jid = waMsg.key?.remoteJid ?? '';
  const end = resolverEnderecoInbound(jid, waMsg.key?.remoteJidAlt, telefoneResolvido);
  if (end.tipo === 'grupo') return { ok: false, motivo: 'grupo', jid };
  if (end.tipo === 'desconhecido') return { ok: false, motivo: 'jid_desconhecido', jid };
  if (!end.telefone) return { ok: false, motivo: 'lid_sem_telefone', jid };

  const from = end.telefone;
  const msg = waMsg.message;
  if (!msg) return { ok: false, motivo: 'sem_conteudo', jid };
  const dados = montarInbound(waMsg, from, msg);
  if (!dados) return { ok: false, motivo: 'tipo_nao_suportado', jid };
  return { ok: true, dados, endereco: end.tipo as 'pn' | 'lid' };
}

/**
 * Compat: mesma assinatura de sempre (dados ou `null`). Quem precisa do MOTIVO
 * do descarte usa `analisarInbound`.
 */
export function extractBaileysInbound(waMsg: BaileysInboundMessage): InboundNormalizado | null {
  const r = analisarInbound(waMsg);
  return r.ok ? r.dados : null;
}

function montarInbound(
  waMsg: BaileysInboundMessage,
  from: string,
  msg: NonNullable<BaileysInboundMessage['message']>,
): InboundNormalizado | null {

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
  /**
   * Throttle das consultas de FOTO DE PERFIL, por instância — mesmo desenho da
   * fila de envio.
   *
   * ⚠️ A SEGURANÇA DISTO DEPENDE DA CONVENÇÃO "UMA RÉPLICA" CONTINUAR VALENDO.
   * Escalar o worker horizontalmente SEM revisar este ponto quebra o throttle
   * em silêncio: cada processo teria o próprio carimbo, e N réplicas
   * multiplicariam por N a taxa de consultas do MESMO número — sem nenhum
   * sinal de que parou de funcionar. Quem mexer em escala mexe aqui também.
   */
  private ultimoPerfilAt = new Map<string, number>();
  private filaDePerfil = new Map<string, Promise<unknown>>();
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
    /**
     * Reserva do `wa_message_id` ANTES do envio. A persistência acontece
     * DENTRO da vez desta mensagem na fila (não no enfileiramento): a linha
     * continua refletindo o envio real, e ainda assim é gravada com folga
     * antes do eco, que a lib agenda num nextTick dentro do sendMessage.
     */
    reserva?: {
      /**
       * Id já existente. Duas origens MUITO diferentes, e o log precisa
       * distingui-las: `reserva-previa` = acabou de ser reservado e gravado
       * por quem chamou (fluxo reativo); `retry` = sobrou de uma tentativa
       * anterior que falhou.
       */
      existente?: string | null;
      origem: 'reserva-previa' | 'retry';
      /** Grava o id. O `await` DESTA promise é a garantia da invariante. */
      persistir: (messageId: string) => Promise<void>;
    },
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

        let messageId: string | undefined;
        if (reserva) {
          // Retry reutiliza o MESMO id: o servidor do WhatsApp deduplica por
          // ele, então uma retentativa do que já chegou não vira entrega dupla.
          messageId = reserva.existente ?? socket.gerarMessageId?.();
          if (messageId) {
            if (reserva.origem === 'retry') {
              // eslint-disable-next-line no-console
              console.log(
                `[worker] retry reutilizando messageId ${messageId} (instância ${instanceId})`,
              );
            }
            await reserva.persistir(messageId); // await CONCLUÍDO antes do socket
          } else {
            /**
             * ⚠️ DEGRADAÇÃO SILENCIOSA — NÃO PODE PASSAR DESPERCEBIDA.
             *
             * Sem `gerarMessageId` (lib sem generateMessageIDV2, ou socket
             * fake), o id só é conhecido DEPOIS do envio — exatamente a
             * corrida com o eco que a reserva existe para eliminar. O envio
             * continua funcionando, mas a invariante caiu para esta mensagem.
             *
             * PRÉ-CONDIÇÃO DA RODADA DO `fromMe`: confirmar que este aviso
             * NUNCA apareceu em produção. Aceitar `fromMe` com este fallback
             * ativo não duplica mensagem — DESTRÓI: o eco insere a linha
             * primeiro, e a gravação do id seguinte colide com
             * ux_messages_wamid, marcando como falha um envio entregue.
             */
            // eslint-disable-next-line no-console
            console.warn(
              `[worker] SEM reserva de messageId na instância ${instanceId}: o socket não ` +
                'expõe gerarMessageId. O envio segue pelo caminho ANTIGO (id só depois do ' +
                'envio) e a corrida com o eco volta a existir para esta mensagem. ' +
                'NÃO aceite `fromMe` enquanto este aviso aparecer.',
            );
          }
        }
        return socket.sendMessage(jid, content, messageId ? { messageId } : undefined);
      });

    // A fila guarda a versão "que nunca rejeita", para um envio com erro não
    // derrubar os próximos da mesma instância.
    this.filaDeEnvio.set(
      instanceId,
      atual.catch(() => undefined),
    );
    return atual;
  }

  /**
   * Atualiza a foto do contato, se estiver vencida. ACESSÓRIO por definição:
   * nunca bloqueia nem derruba o processamento da mensagem — por isso é
   * chamado sem await e engole o próprio erro (com log).
   *
   * Cache negativo: sem foto ou recusa por privacidade grava `avatar_url` nulo
   * COM carimbo. Sem isso, contato sem foto viraria uma chamada de rede por
   * mensagem, para sempre.
   */
  async atualizarAvatarSeVencido(instance: Instance, phone: string): Promise<void> {
    const socket = this.sockets.get(instance.id);
    if (!socket?.profilePictureUrl) return; // Meta não passa por aqui

    const contato = await this.repo.contacts.getByPhone(instance.id, phone);
    if (!contato) return;
    const ttlMs = (this.opts.avatarTtlHours ?? AVATAR_TTL_HOURS) * 3600_000;
    const buscadoEm = contato.avatar_fetched_at ? Date.parse(contato.avatar_fetched_at) : 0;
    if (buscadoEm && Date.now() - buscadoEm < ttlMs) return; // ainda vale

    const url = await this.comThrottleDePerfil(instance.id, async () => {
      try {
        return (await socket.profilePictureUrl!(toJid(phone), 'preview')) ?? null;
      } catch (err) {
        // Recusa por privacidade lança (Boom). Não é erro nosso: é "sem foto".
        // eslint-disable-next-line no-console
        console.log(
          `[worker] avatar indisponível para ${phone} (instância ${instance.id}): ` +
            `${(err as Error).message}`,
        );
        return null;
      }
    });
    await this.repo.contacts.setAvatar(instance.id, phone, url, new Date().toISOString());
  }

  /**
   * ⚠️ DIAGNÓSTICO TEMPORÁRIO — REMOVER APÓS COLETAR O DADO. ⚠️
   *
   * Pergunta que ele responde: por que `profilePictureUrl` volta VAZIA (sem
   * lançar) para um contato que tem foto. Três hipóteses, e este log separa
   * as três de uma vez:
   *
   *  1. privacidade do contato  → ambos os JIDs vazios E privacidade OK
   *  2. JID errado (@lid)       → viaLid traz URL e viaTelefone não
   *  3. tcToken ausente         → privacidade com ERRO (fetchPrivacySettings
   *     falhou no boot, e é ela que decide se a consulta leva o token —
   *     chats.js:558). Sem token, o servidor responde sem url e sem erro.
   *
   * Roda FORA do TTL de propósito: o contato de teste já foi carimbado, então
   * esperar o TTL vencer adiaria o diagnóstico em 24h.
   */
  async diagnosticoAvatarLid(
    instance: Instance,
    phone: string,
    jidOriginal: string | null | undefined,
  ): Promise<void> {
    if (!jidOriginal?.endsWith('@lid')) return; // só o caso em investigação
    const socket = this.sockets.get(instance.id);
    if (!socket?.profilePictureUrl) return;

    const tentar = async (jid: string): Promise<string> => {
      try {
        return (await socket.profilePictureUrl!(jid, 'preview')) ?? '(vazio)';
      } catch (err) {
        return `ERRO: ${(err as Error).message}`;
      }
    };

    // Mesma fila de perfil: o diagnóstico não fura o throttle da instância.
    const viaTelefone = await this.comThrottleDePerfil(instance.id, () => tentar(toJid(phone)));
    const viaLid = await this.comThrottleDePerfil(instance.id, () => tentar(jidOriginal));

    let privacidade: string;
    try {
      privacidade = JSON.stringify((await socket.fetchPrivacySettings?.(true)) ?? null);
    } catch (err) {
      privacidade = `ERRO: ${(err as Error).message}`;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[worker] AVATAR-DIAG telefone=${phone} jidOriginal=${jidOriginal}\n` +
        `   viaTelefone(${toJid(phone)}) = ${viaTelefone}\n` +
        `   viaLid(${jidOriginal}) = ${viaLid}\n` +
        `   privacidade = ${privacidade}`,
    );
  }

  /** Fila de consultas de perfil por instância (ver ultimoPerfilAt). */
  private async comThrottleDePerfil<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    const intervalo = this.opts.minProfileIntervalMs ?? BAILEYS_MIN_PROFILE_INTERVAL_MS;
    const anterior = this.filaDePerfil.get(instanceId) ?? Promise.resolve();
    const atual = anterior
      .catch(() => undefined)
      .then(async () => {
        const desde = Date.now() - (this.ultimoPerfilAt.get(instanceId) ?? 0);
        const espera = Math.max(0, intervalo - desde);
        if (espera > 0) await new Promise((r) => setTimeout(r, espera));
        this.ultimoPerfilAt.set(instanceId, Date.now());
        return fn();
      });
    this.filaDePerfil.set(
      instanceId,
      atual.catch(() => undefined),
    );
    return atual;
  }

  /** Sender reativo: envia DIRETO pelo socket vivo da instância (com throttle). */
  socketSender(): BaileysSender {
    return {
      /**
       * O id é reservado ANTES do envio e a linha em `messages` é gravada por
       * sendViaProvider com ele — por isso aqui a `persistir` é no-op: o
       * trabalho já foi feito, só repassamos o id ao socket.
       */
      reserveMessageId: (instance) =>
        this.sockets.get(instance.id)?.gerarMessageId?.() ?? null,
      send: async (instance, to, payload, opts): Promise<SendResult> => {
        const socket = this.sockets.get(instance.id);
        if (!socket) throw new Error(`Instância ${instance.id} sem socket conectado`);
        const jid = toJid(to);
        const res = await this.enviarComThrottle(
          instance.id,
          socket,
          jid,
          toSocketContent(payload, jid),
          // Sempre 'reserva-previa': sendViaProvider já reservou e gravou o id
          // antes de chegar aqui. NUNCA é retry — o retry do reativo é do
          // motor de fluxos, não deste caminho.
          opts?.messageId
            ? {
                existente: opts.messageId,
                origem: 'reserva-previa' as const,
                persistir: async () => undefined,
              }
            : undefined,
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
    socket.ev.on('messages.upsert', ((u: {
      messages?: BaileysInboundMessage[];
      type?: string;
    }) => {
      for (const msg of u.messages ?? []) {
        if (msg.key?.fromMe) {
          // Mensagem NOSSA: ou é o eco de um envio do painel (já registrado),
          // ou foi enviada de fora — do celular, de outro aparelho pareado.
          // O `upsertType` segue no log como observação: em produção o eco do
          // nosso socket vem 'append' e o envio de fora vem 'notify'. É SINAL,
          // não mecanismo: quem decide é o wa_message_id.
          void this.handleOutgoingEcho(instance, msg, u.type).catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              `[worker] eco fromMe falhou — instância=${instance.id} (${instance.name}) ` +
                `msg=${msg.key?.id ?? '-'}:`,
              err,
            );
          });
          continue;
        }
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

  /**
   * MENSAGEM ENVIADA POR NÓS (`key.fromMe`), vinda do socket.
   *
   * Duas origens, e o `wa_message_id` distingue as duas com CERTEZA (nada de
   * heurística de texto + janela de tempo):
   *
   *  - ECO de envio do painel/bot: o id JÁ está em `messages`, porque desde
   *    §reserva ele é gravado ANTES do socket.sendMessage. Ignora.
   *  - ENVIO DE FORA (celular, outro aparelho pareado): id desconhecido.
   *    Grava como saída, para o Live Chat mostrar o que foi dito por fora.
   *
   * NÃO É CAMINHO DE INBOUND. De propósito não passa por `recordInbound`:
   *  - `handleFlowInbound` NUNCA roda — responder pelo celular com uma palavra
   *    que por acaso é gatilho não pode ligar o chatbot em cima do cliente.
   *    Esta é a regra mais importante daqui, e a forma de garanti-la é não ter
   *    o caminho, em vez de ter e desviar.
   *  - `touchLastSeen` não roda: `last_seen` é "quando o CONTATO falou".
   *  - CRM não é tocado (decisão de negócio em aberto — ver relatório).
   *  - `processPendingExecutions` não roda: ele retoma delays vencidos e não
   *    depende do conteúdo; o inbound seguinte do contato já o dispara.
   */
  async handleOutgoingEcho(
    instance: Instance,
    waMsg: BaileysInboundMessage,
    upsertType?: string,
  ): Promise<void> {
    const waMessageId = waMsg.key?.id ?? null;
    const jidCru = waMsg.key?.remoteJid ?? '-';
    const marca =
      `instância=${instance.id} (${instance.name}) upsertType=${upsertType ?? '-'} ` +
      `remoteJid=${jidCru} msg=${waMessageId ?? '-'}`;

    // 1. DEDUP DETERMINÍSTICO — o caso comum (envio pelo painel).
    if (waMessageId) {
      const jaExiste = await this.repo.messages.getByWaMessageId(instance.id, waMessageId);
      if (jaExiste) {
        // eslint-disable-next-line no-console
        console.log(`[worker] eco de mensagem já registrada, ignorado — ${marca}`);
        return;
      }
    }

    // 2. Endereço do CONTATO. Numa mensagem fromMe o `remoteJid` continua
    // sendo o jid dele (chatId = recipient), então a resolução é a MESMA do
    // inbound — inclusive @lid. Reusada, não duplicada. Ela também é o filtro:
    // grupo, status@broadcast, protocolo, reação e edição não passam daqui.
    let analise = analisarInbound(waMsg);
    if (!analise.ok && analise.motivo === 'lid_sem_telefone') {
      const pn = await this.resolverPnDeLid(instance.id, analise.jid);
      if (pn) analise = analisarInbound(waMsg, pn);
    }
    if (!analise.ok) {
      // eslint-disable-next-line no-console
      console.log(`[worker] eco fromMe DESCARTADO — motivo=${analise.motivo} ${marca}`);
      return;
    }

    const contato = analise.dados.from;
    // Número da empresa. Mesmo fallback do inbound (janela até own_number ser
    // preenchido no primeiro 'open' pós-migration 014).
    const proprio = instance.own_number ?? instance.phone_number_id ?? '000000000';

    // 3. Contato: cria se não existir, SEM tocar em nome nem last_seen.
    // `pushName` aqui é o nome do DONO DA CONTA, não do contato — e o upsert
    // faz COALESCE, então null preserva o que já houver. Contato novo fica com
    // nome nulo e o painel exibe o telefone; o profile.name real entra quando
    // o contato escrever.
    await this.repo.contacts.upsert({
      instance_id: instance.id,
      phone: contato,
      name: null,
      last_seen: null,
    });

    // 4. A mensagem, com os papéis invertidos.
    try {
      await this.repo.messages.create({
        instance_id: instance.id,
        direction: 'out',
        from_number: proprio,
        to_number: contato,
        type: analise.dados.type,
        content: analise.dados.content,
        status: 'sent',
        error_code: null,
        error_message: null,
        wa_message_id: waMessageId,
        campaign_id: null,
      });
    } catch (err) {
      // Corrida de dois ecos do mesmo id: ux_messages_wamid barra o segundo.
      // Se a linha existe agora, o trabalho está feito — não é falha.
      if (waMessageId && (await this.repo.messages.getByWaMessageId(instance.id, waMessageId))) {
        // eslint-disable-next-line no-console
        console.log(`[worker] eco concorrente já gravado, ignorado — ${marca}`);
        return;
      }
      throw err;
    }

    // Avatar: MESMO gancho do inbound (handleIncoming), pelo mesmo motivo —
    // acabamos de tocar neste contato, então é a hora de conferir a foto.
    //
    // Ficou de fora quando este caminho nasceu: o avatar foi escrito antes do
    // `fromMe` existir, e ninguém ligou os dois. Resultado em produção: um
    // contato que só recebe mensagens NOSSAS nunca teria a foto buscada.
    //
    // Não-bloqueante e sem lógica duplicada: TTL, throttle por instância e
    // cache negativo vivem todos dentro de atualizarAvatarSeVencido.
    void this.atualizarAvatarSeVencido(instance, contato).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[worker] falha ao atualizar avatar de ${contato}:`, err);
    });
    // ⚠️ TEMPORÁRIO — remover junto com diagnosticoAvatarLid.
    void this.diagnosticoAvatarLid(instance, contato, waMsg.key?.remoteJid).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[worker] AVATAR-DIAG falhou:', err);
    });

    // eslint-disable-next-line no-console
    console.log(
      `[worker] envio de FORA registrado (${analise.endereco}) — ${marca} ` +
        `de=${proprio} para=${contato} tipo=${analise.dados.type}`,
    );
  }

  /** Inbound do socket → MESMO núcleo do webhook (contato, CRM, msg, fluxos). */
  async handleIncoming(instance: Instance, waMsg: BaileysInboundMessage): Promise<void> {
    let analise = analisarInbound(waMsg);

    // Inbound em @lid SEM o telefone no payload: pergunta ao mapa LID→PN da
    // própria lib antes de desistir (socket.signalRepository.lidMapping).
    if (!analise.ok && analise.motivo === 'lid_sem_telefone') {
      const pn = await this.resolverPnDeLid(instance.id, analise.jid);
      if (pn) analise = analisarInbound(waMsg, pn);
    }

    if (!analise.ok) {
      // NUNCA silencioso (era assim que este bug sobreviveu desde o commit
      // inicial). Se o WhatsApp inventar um formato novo, ele aparece AQUI, com
      // o jid cru — em vez de virar outra investigação do zero.
      const nivel = analise.motivo === 'grupo' ? 'log' : 'warn';
      // eslint-disable-next-line no-console
      console[nivel](
        `[worker] inbound DESCARTADO — instância=${instance.id} (${instance.name}) ` +
          `motivo=${analise.motivo} remoteJid=${analise.jid || '(vazio)'} ` +
          `msg=${waMsg.key?.id ?? '-'}`,
      );
      return;
    }

    const normalized = analise.dados;
    // Aceito: uma linha por inbound, com o telefone JÁ resolvido. É o que
    // permite conferir o parsing por log, sem cruzar a tabela messages.
    // eslint-disable-next-line no-console
    console.log(
      `[worker] inbound aceito (${analise.endereco}) — instância=${instance.id} ` +
        `remoteJid=${waMsg.key?.remoteJid ?? '-'} telefone=${normalized.from} ` +
        `tipo=${normalized.type} msg=${normalized.waMessageId ?? '-'}`,
    );

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
    // Avatar: acessório e NÃO-bloqueante — a mensagem já está gravada, e uma
    // falha ou lentidão aqui não pode atrasar fluxo nem derrubar o inbound.
    void this.atualizarAvatarSeVencido(instance, normalized.from).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[worker] falha ao atualizar avatar de ${normalized.from}:`, err);
    });
    // ⚠️ TEMPORÁRIO — remover junto com diagnosticoAvatarLid.
    void this.diagnosticoAvatarLid(instance, normalized.from, waMsg.key?.remoteJid).catch(
      (err) => {
        // eslint-disable-next-line no-console
        console.warn('[worker] AVATAR-DIAG falhou:', err);
      },
    );

    // Mesmo gancho da web: inbound dispara a varredura de retomadas.
    await processPendingExecutions(this.repo, instance.id, this.flowDeps());
  }

  /**
   * LID → telefone, pelo mapa que a própria lib mantém (e que nós já
   * persistimos em `baileys_auth`, tipo `lid-mapping`). Falha aqui NUNCA
   * derruba o inbound: devolve null e o descarte sai logado com o motivo.
   */
  private async resolverPnDeLid(instanceId: string, lid: string): Promise<string | null> {
    try {
      const mapa = this.sockets.get(instanceId)?.signalRepository?.lidMapping;
      if (!mapa) return null;
      return await mapa.getPNForLID(lid);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[worker] falha ao resolver LID ${lid} da instância ${instanceId}:`,
        (err as Error).message,
      );
      return null;
    }
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
          // Id JÁ reservado numa tentativa anterior? Reutiliza (o servidor
          // deduplica por ele). A linha em messages foi criada no enqueue com
          // wa_message_id nulo — quem o preenche é a reserva abaixo.
          const jaReservado = item.message_id
            ? ((await this.repo.messages.getById(item.message_id))?.wa_message_id ?? null)
            : null;

          // MESMO portão do envio reativo: o intervalo mínimo vale para o
          // número, não para o caminho por onde a mensagem chegou.
          // Fica com o id efetivamente reservado (null se o socket não souber
          // gerar — ver o fallback logo abaixo).
          let idPersistido: string | null = jaReservado;
          const res = await this.enviarComThrottle(
            instanceId,
            socket,
            jid,
            toSocketContent(item.payload as BaileysSendPayload, jid),
            {
              existente: jaReservado,
              // Id que sobrou de tentativa anterior = retry de verdade.
              origem: jaReservado ? ('retry' as const) : ('reserva-previa' as const),
              persistir: async (messageId) => {
                idPersistido = messageId;
                if (item.message_id) {
                  await this.repo.messages.updateById(item.message_id, {
                    wa_message_id: messageId,
                  });
                }
              },
            },
          );
          await this.repo.outbox.markSent(item.id);
          if (item.message_id) {
            // Com reserva, só o status evolui — regravar o wa_message_id aqui
            // reabriria a corrida com o eco. SEM reserva (socket que não sabe
            // gerar id), cai no comportamento antigo: id do retorno do envio.
            await this.repo.messages.updateById(item.message_id, {
              status: 'sent',
              ...(idPersistido ? {} : { wa_message_id: res?.key?.id ?? null }),
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
