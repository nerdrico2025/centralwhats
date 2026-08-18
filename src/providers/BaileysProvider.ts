import type { Repo } from '../repo/Repo';
import type { Instance } from '../repo/types';
import type {
  ListSection,
  MediaPayload,
  Provider,
  ProviderCapabilities,
  ReplyButton,
  SendResult,
} from './types';

/**
 * Payload NORMALIZADO de envio Baileys — é o que a outbox armazena e o que o
 * worker converte para o formato do socket. Mesma forma nos dois transportes.
 */
export type BaileysSendPayload =
  | { type: 'text'; text: string }
  | { type: 'media'; media: MediaPayload }
  | { type: 'buttons'; body: string; buttons: ReplyButton[] }
  | { type: 'list'; body: string; buttonText: string; sections: ListSection[] }
  | { type: 'reaction'; messageId: string; emoji: string };

/**
 * Transporte de envio do Baileys:
 *  - Web (serverless): OUTBOX — insere a intenção; o worker consome e envia.
 *  - Worker (sempre-ligado): SOCKET — envia direto pela conexão viva.
 */
export interface BaileysSender {
  send(
    instance: Instance,
    to: string,
    payload: BaileysSendPayload,
    /** Id JÁ reservado e persistido pelo chamador (ver reserveMessageId). */
    opts?: { messageId?: string | null },
  ): Promise<SendResult>;
  /**
   * Reserva o id da PRÓXIMA mensagem, quando o transporte permite.
   *
   * POR QUE EXISTE: o Baileys emite o eco da própria mensagem
   * (`messages.upsert` com fromMe) num `process.nextTick` DENTRO do
   * `sendMessage`, antes dele retornar — sempre antes de qualquer ida ao
   * Postgres. Quem grava o `wa_message_id` depois do envio perde essa corrida.
   * Reservando o id ANTES, a linha já existe quando o eco chega.
   *
   * `null` = transporte não permite (a outbox não tem socket; a Meta atribui o
   * wamid do lado dela). Nesse caso vale o comportamento antigo.
   */
  reserveMessageId?(instance: Instance): string | null;
}

/** Sender da camada web: enfileira na outbox (retorna status 'queued'). */
export function makeOutboxSender(repo: Repo): BaileysSender {
  return {
    async send(instance, to, payload) {
      const item = await repo.outbox.enqueue({
        instance_id: instance.id,
        to_number: to,
        payload,
        message_id: null, // linkado pelo serviço de mensageria após logar
      });
      // Sem socket aqui: quem reserva o id é o WORKER, na hora de enviar.
      return { waMessageId: null, status: 'queued', outboxId: item.id };
    },
  };
}

/**
 * Provider Baileys (API não-oficial) — V2. Traduz a interface Provider no
 * payload normalizado e delega ao transporte injetado. O resto do sistema
 * continua chamando só provider.* — nada muda no motor de fluxos/campanhas.
 *
 * Capacidades: sem templates/HSM e sem cta_url (só existem na oficial). A UI
 * usa `capabilities` para esconder o que este tipo de instância não faz.
 * Botões/listas existem mas com formato próprio (convertido no worker).
 */
export class BaileysProvider implements Provider {
  readonly type = 'baileys' as const;

  readonly capabilities: ProviderCapabilities = {
    text: true,
    media: true,
    template: false, // sem HSM no Baileys
    buttons: true,
    list: true,
    reaction: true,
    cta: false, // cta_url é interativo da oficial
  };

  constructor(private readonly sender: BaileysSender) {}

  /**
   * Id reservado para o envio DESTA instância de provider. O provider é criado
   * por envio (getProvider em sendViaProvider), então não há estado
   * atravessando mensagens — é um repasse, não um cache.
   */
  private idReservado: string | null = null;

  reserveMessageId(instance: Instance): string | null {
    this.idReservado = this.sender.reserveMessageId?.(instance) ?? null;
    return this.idReservado;
  }

  sendText(instance: Instance, to: string, text: string): Promise<SendResult> {
    return this.sender.send(instance, to, { type: 'text', text }, { messageId: this.idReservado });
  }

  sendMedia(instance: Instance, to: string, media: MediaPayload): Promise<SendResult> {
    return this.sender.send(instance, to, { type: 'media', media }, { messageId: this.idReservado });
  }

  sendTemplate(): Promise<SendResult> {
    // capabilities.template === false — o serviço de mensageria barra antes.
    throw new Error('Templates/HSM não existem no Baileys');
  }

  sendButtons(
    instance: Instance,
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult> {
    return this.sender.send(instance, to, { type: 'buttons', body, buttons }, { messageId: this.idReservado });
  }

  sendList(
    instance: Instance,
    to: string,
    body: string,
    buttonText: string,
    sections: ListSection[],
  ): Promise<SendResult> {
    return this.sender.send(instance, to, { type: 'list', body, buttonText, sections }, { messageId: this.idReservado });
  }

  sendReaction(
    instance: Instance,
    to: string,
    messageId: string,
    emoji: string,
  ): Promise<SendResult> {
    return this.sender.send(instance, to, { type: 'reaction', messageId, emoji }, { messageId: this.idReservado });
  }

  sendCtaUrl(): Promise<SendResult> {
    // capabilities.cta === false — barrado antes.
    throw new Error('cta_url não existe no Baileys');
  }
}
