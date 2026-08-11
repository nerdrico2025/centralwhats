import type { Instance } from '../repo/types';
import { normalizePhone } from '../util/phone';
import { MetaApiError } from './errors';
import {
  buildBodyComponent,
  buildButtonComponents,
  buildHeaderComponent,
  splitTemplateVars,
} from './templateComponents';
import type {
  ListSection,
  MediaPayload,
  Provider,
  ProviderCapabilities,
  ReplyButton,
  SendResult,
} from './types';

type FetchImpl = typeof fetch;

export interface MetaCloudProviderOptions {
  /** Injetável para testes (mock da Graph API). Default: fetch global. */
  fetchImpl?: FetchImpl;
  /** Base da Graph API. Default: env GRAPH_API_BASE ou graph.facebook.com. */
  baseUrl?: string;
  /** Versão da API. Default: env GRAPH_API_VERSION ou v21.0. */
  apiVersion?: string;
}

/**
 * Provider da API Oficial (Meta Cloud API / Graph API) — V1.
 * SÓ transporte: monta o payload, chama a Graph API e normaliza o resultado.
 * A gravação em `messages` fica no serviço de mensageria (domain/messaging),
 * para que todos os providers loguem de forma idêntica.
 *
 * Nenhum outro módulo chama a Graph API diretamente — só passa por aqui.
 */
export class MetaCloudProvider implements Provider {
  readonly type = 'meta' as const;

  readonly capabilities: ProviderCapabilities = {
    text: true,
    media: true,
    template: true, // HSM só existe na oficial
    buttons: true,
    list: true,
    reaction: true,
    cta: true,
  };

  private readonly fetchImpl: FetchImpl;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(opts: MetaCloudProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? process.env.GRAPH_API_BASE ?? 'https://graph.facebook.com')
      .replace(/\/+$/, '');
    this.apiVersion = opts.apiVersion ?? process.env.GRAPH_API_VERSION ?? 'v21.0';
  }

  /** Envia um objeto de mensagem já montado ao endpoint /{phone_number_id}/messages. */
  private async post(instance: Instance, message: Record<string, unknown>): Promise<SendResult> {
    if (!instance.phone_number_id) {
      throw new MetaApiError(null, 'Instância sem phone_number_id configurado', 400);
    }
    if (!instance.token) {
      throw new MetaApiError(null, 'Instância sem token configurado', 400);
    }
    const url = `${this.baseUrl}/${this.apiVersion}/${instance.phone_number_id}/messages`;
    const body = { messaging_product: 'whatsapp', ...message };

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${instance.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

    if (!resp.ok) {
      // Erro da Meta: { error: { message, code, error_subcode, ... } }
      const err = (json.error as Record<string, unknown>) ?? {};
      const code = err.code != null ? String(err.code) : null;
      const message = (err.message as string) ?? `Graph API respondeu ${resp.status}`;
      throw new MetaApiError(code, message, resp.status, json);
    }

    const messages = (json.messages as { id?: string }[]) ?? [];
    return { waMessageId: messages[0]?.id ?? null, status: 'sent', raw: json };
  }

  sendText(instance: Instance, to: string, text: string): Promise<SendResult> {
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  sendMedia(instance: Instance, to: string, media: MediaPayload): Promise<SendResult> {
    const ref: Record<string, unknown> = {};
    if (media.mediaId) ref.id = media.mediaId;
    else if (media.url) ref.link = media.url;
    if (media.caption && media.kind !== 'audio') ref.caption = media.caption;
    if (media.filename && media.kind === 'document') ref.filename = media.filename;

    return this.post(instance, {
      to: normalizePhone(to),
      type: media.kind,
      [media.kind]: ref,
    });
  }

  sendTemplate(
    instance: Instance,
    to: string,
    template: { name: string; language: string; components?: unknown },
    vars?: Record<string, string>,
  ): Promise<SendResult> {
    // REGRA: usar o idioma EXATO recebido (vem do template sincronizado na Meta,
    // P1.4). Nunca assumir pt_BR. Aqui `template.language` é a fonte da verdade.
    const components: Record<string, unknown>[] = [];
    const { bodyVars, buttonVars, headerVars } = splitTemplateVars(vars);

    // Header dinâmico (TEXT com {{1}} ou mídia) exige component próprio — mesma
    // classe de falha do botão: sem ele, 132000.
    components.push(...buildHeaderComponent(template.components, headerVars, template.name));

    // Corpo: valida a CONTAGEM contra os placeholders do template sincronizado
    // antes de gastar a chamada — mesma classe de falha do botão/header (132000).
    components.push(...buildBodyComponent(template.components, bodyVars, template.name));

    // Botões de URL dinâmica exigem um component próprio por botão; sem ele a
    // Meta rejeita com 132000 (contagem de parâmetros).
    components.push(...buildButtonComponents(template.components, buttonVars, template.name));
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(components.length ? { components } : {}),
      },
    });
  }

  sendButtons(
    instance: Instance,
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult> {
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    });
  }

  sendList(
    instance: Instance,
    to: string,
    body: string,
    buttonText: string,
    sections: ListSection[],
  ): Promise<SendResult> {
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText,
          sections: sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      },
    });
  }

  sendReaction(
    instance: Instance,
    to: string,
    messageId: string,
    emoji: string,
  ): Promise<SendResult> {
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    });
  }

  sendCtaUrl(
    instance: Instance,
    to: string,
    body: string,
    buttonText: string,
    url: string,
  ): Promise<SendResult> {
    return this.post(instance, {
      to: normalizePhone(to),
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: body },
        action: { name: 'cta_url', parameters: { display_text: buttonText, url } },
      },
    });
  }
}
