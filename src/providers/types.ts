import type { Instance } from '../repo/types';

/**
 * Tipos da camada provider.*. Todo envio de mensagem passa por aqui,
 * independente de ser API Oficial (Meta) ou Baileys. Nenhum módulo de negócio
 * chama a Graph API / Baileys diretamente.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface MediaPayload {
  kind: MediaKind;
  /** URL pública ou id de mídia já carregada no provedor. */
  url?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

/** Resultado normalizado de um envio, agnóstico ao provedor. */
export interface SendResult {
  /** wa_message_id retornado pelo provedor, quando disponível. */
  waMessageId: string | null;
  /** Status inicial informado pelo provedor. */
  status: 'queued' | 'sent';
  raw?: unknown;
  /** [V2] id do item de outbox (envio Baileys enfileirado pela web). */
  outboxId?: string;
}

/**
 * Capacidades declaradas por cada provider. A UI usa isso para esconder o que
 * o tipo de instância não suporta, em vez de falhar em silêncio.
 * Ex.: templates/HSM só existem na oficial; o Baileys não os suporta.
 */
export interface ProviderCapabilities {
  text: boolean;
  media: boolean;
  template: boolean;
  buttons: boolean;
  list: boolean;
  reaction: boolean;
  cta: boolean;
}

export interface Provider {
  readonly type: Instance['provider_type'];
  readonly capabilities: ProviderCapabilities;

  sendText(instance: Instance, to: string, text: string): Promise<SendResult>;

  sendMedia(
    instance: Instance,
    to: string,
    media: MediaPayload,
  ): Promise<SendResult>;

  /** Só faz sentido na oficial (HSM). language = idioma exato cadastrado na Meta. */
  sendTemplate(
    instance: Instance,
    to: string,
    template: { name: string; language: string },
    vars?: Record<string, string>,
  ): Promise<SendResult>;

  sendButtons(
    instance: Instance,
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult>;

  sendList(
    instance: Instance,
    to: string,
    body: string,
    buttonText: string,
    sections: ListSection[],
  ): Promise<SendResult>;

  sendReaction(
    instance: Instance,
    to: string,
    messageId: string,
    emoji: string,
  ): Promise<SendResult>;

  /** Botão de call-to-action com URL (mensagem interativa cta_url da Meta). */
  sendCtaUrl(
    instance: Instance,
    to: string,
    body: string,
    buttonText: string,
    url: string,
  ): Promise<SendResult>;
}
