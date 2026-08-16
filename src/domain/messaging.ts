import type { Repo } from '../repo';
import type { Instance, Message } from '../repo/types';
import { getProvider, makeOutboxSender } from '../providers';
import {
  MetaApiError,
  TemplateParamsError,
  UnsupportedByProviderError,
} from '../providers/errors';
import { classifySendError, descreverErroDeEnvio } from '../providers/classifySendError';
import type {
  ListSection,
  MediaPayload,
  Provider,
  ProviderCapabilities,
  ReplyButton,
  SendResult,
} from '../providers/types';
import { normalizePhone } from '../util/phone';
import { resolveTemplate } from './templates';

/** Entrada de envio avulso — união discriminada por `type`. */
export type SendInput =
  | { type: 'text'; to: string; text: string }
  | { type: 'media'; to: string; media: MediaPayload }
  | {
      type: 'template';
      to: string;
      // language é opcional: se omitido, é resolvido pelo template sincronizado
      // (fonte da verdade da Meta). Nunca há default pt_BR.
      template: { name: string; language?: string };
      vars?: Record<string, string>;
    }
  | { type: 'buttons'; to: string; body: string; buttons: ReplyButton[] }
  | { type: 'list'; to: string; body: string; buttonText: string; sections: ListSection[] }
  | { type: 'reaction'; to: string; messageId: string; emoji: string }
  | { type: 'cta_url'; to: string; body: string; buttonText: string; url: string };

/** Falha de envio já logada em messages. Carrega o código/mensagem da Meta. */
export class SendFailedError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
    readonly httpStatus: number,
    readonly loggedMessageId: string,
  ) {
    super(message);
    this.name = 'SendFailedError';
  }
}

export interface MessagingDeps {
  /** Resolve o provider da instância. Injetável em testes (mock). */
  providerFor?: (instance: Instance) => Provider;
}

/** Capacidade exigida por tipo de envio (para checar provider.capabilities). */
const CAPABILITY: Record<SendInput['type'], keyof ProviderCapabilities> = {
  text: 'text',
  media: 'media',
  template: 'template',
  buttons: 'buttons',
  list: 'list',
  reaction: 'reaction',
  cta_url: 'cta',
};

/** Tipo interno gravado em messages.type. */
function messageType(input: SendInput): string {
  switch (input.type) {
    case 'media':
      return input.media.kind;
    case 'buttons':
    case 'list':
    case 'cta_url':
      return 'interactive';
    default:
      return input.type; // 'text' | 'template' | 'reaction'
  }
}

/** Conteúdo estruturado gravado em messages.content (sem o campo `to`). */
function messageContent(input: SendInput): unknown {
  const rest = { ...input } as Record<string, unknown>;
  delete rest.to;
  return rest;
}

function callProvider(
  provider: Provider,
  instance: Instance,
  input: SendInput,
  resolvedTemplateLanguage?: string,
  templateComponents?: unknown,
): Promise<SendResult> {
  switch (input.type) {
    case 'text':
      return provider.sendText(instance, input.to, input.text);
    case 'media':
      return provider.sendMedia(instance, input.to, input.media);
    case 'template':
      return provider.sendTemplate(
        instance,
        input.to,
        {
          name: input.template.name,
          language: resolvedTemplateLanguage ?? '',
          components: templateComponents,
        },
        input.vars,
      );
    case 'buttons':
      return provider.sendButtons(instance, input.to, input.body, input.buttons);
    case 'list':
      return provider.sendList(instance, input.to, input.body, input.buttonText, input.sections);
    case 'reaction':
      return provider.sendReaction(instance, input.to, input.messageId, input.emoji);
    case 'cta_url':
      return provider.sendCtaUrl(instance, input.to, input.body, input.buttonText, input.url);
  }
}

/**
 * Envia uma mensagem avulsa por uma instância e LOGA o resultado em messages
 * (direction=out) — sucesso E falha (CLAUDE.md: "logue TODO envio").
 *
 * - Usa provider.* (getProvider). NUNCA chama a Graph API direto.
 * - Sucesso: grava com wa_message_id retornado pela Meta e status inicial.
 * - Falha da Meta: grava status=failed com error_code/error_message e lança
 *   SendFailedError (estruturado) para o handler devolver ao client.
 *
 * @param campaignId opcional — vincula a mensagem a uma campanha (P3).
 */
export async function sendViaProvider(
  repo: Repo,
  instance: Instance,
  input: SendInput,
  deps: MessagingDeps = {},
  campaignId: string | null = null,
): Promise<{ message: Message; result: SendResult }> {
  // Default: Meta direto; Baileys via OUTBOX (a camada web nunca fala com o
  // socket — o worker consome a intenção e envia).
  const provider = deps.providerFor
    ? deps.providerFor(instance)
    : getProvider(instance, { baileysSender: makeOutboxSender(repo) });

  // Respeita capacidades do provider (ex.: template/cta não existem no Baileys).
  const cap = CAPABILITY[input.type];
  if (!provider.capabilities[cap]) {
    throw new UnsupportedByProviderError(cap, provider.type);
  }

  // Template: resolve o idioma pelo registro SINCRONIZADO (fonte da verdade).
  // Nunca há default pt_BR — resolveTemplateLanguage lança se for ambíguo.
  let resolvedTemplateLanguage: string | undefined;
  let templateComponents: unknown;
  let contentInput: SendInput = input;
  if (input.type === 'template') {
    const resolved = await resolveTemplate(
      repo,
      instance,
      input.template.name,
      input.template.language,
    );
    resolvedTemplateLanguage = resolved.language;
    templateComponents = resolved.components;
    contentInput = {
      ...input,
      template: { name: input.template.name, language: resolvedTemplateLanguage },
    };
  }

  // Número da EMPRESA neste envio. `own_number` é o número real da instância
  // (Baileys aprende no pareamento — §3.5); `phone_number_id` é o id da Meta,
  // que só faz sentido em instância oficial.
  //
  // JANELA DE TRANSIÇÃO: instância Baileys pareada ANTES da migration 014 fica
  // com own_number nulo até reconectar (o worker preenche no 'open'). Nesse
  // intervalo o fallback mantém o comportamento antigo em vez de gravar vazio —
  // some sozinho na primeira reconexão.
  const from = instance.own_number ?? instance.phone_number_id ?? '';
  const to = normalizePhone(input.to);
  const type = messageType(input);
  const content = messageContent(contentInput);

  try {
    const result = await callProvider(
      provider,
      instance,
      input,
      resolvedTemplateLanguage,
      templateComponents,
    );
    const message = await repo.messages.create({
      instance_id: instance.id,
      direction: 'out',
      from_number: from,
      to_number: to,
      type,
      content,
      status: result.status === 'queued' ? 'queued' : 'sent',
      error_code: null,
      error_message: null,
      wa_message_id: result.waMessageId,
      campaign_id: campaignId,
    });
    // Envio Baileys enfileirado: linka a outbox ao registro logado, para o
    // worker confirmar (queued→sent) depois de enviar de verdade.
    if (result.outboxId) {
      await repo.outbox.setMessageId(result.outboxId, message.id);
    }
    return { message, result };
  } catch (err) {
    // Parâmetros de template inválidos: barrado ANTES da Graph API, mas ainda é
    // um envio que aconteceu do ponto de vista do usuário — loga igual.
    if (err instanceof TemplateParamsError) {
      const logged = await repo.messages.create({
        instance_id: instance.id,
        direction: 'out',
        from_number: from,
        to_number: to,
        type,
        content,
        status: 'failed',
        error_code: 'TEMPLATE_PARAMS',
        error_message: err.message,
        wa_message_id: null,
        campaign_id: campaignId,
      });
      throw new SendFailedError('TEMPLATE_PARAMS', err.message, 400, logged.id);
    }
    if (err instanceof MetaApiError) {
      // Loga a FALHA (nunca "só grava se deu certo").
      const logged = await repo.messages.create({
        instance_id: instance.id,
        direction: 'out',
        from_number: from,
        to_number: to,
        type,
        content,
        status: 'failed',
        error_code: err.code,
        error_message: err.message,
        wa_message_id: null,
        campaign_id: campaignId,
      });
      throw new SendFailedError(err.code, err.message, err.httpStatus, logged.id);
    }

    // QUALQUER OUTRO ERRO (Baileys, rede, bug nosso). Antes ele era re-lançado
    // cru: nenhuma linha em `messages`, nenhum código, e o disparo em massa
    // registrava `error_code: null` sem saber o que aconteceu. Era a falha
    // silenciosa que o CLAUDE.md proíbe.
    //
    // Agora passa pelo classificador agnóstico: o histórico ganha um código
    // (mesmo que seja o `kind`), e quem decide retry lê `retryable`.
    const cls = classifySendError(err, provider.type);
    // eslint-disable-next-line no-console
    console.error(
      `[envio] falha na instância ${instance.id} (${provider.type}) — ${descreverErroDeEnvio(cls)}`,
    );
    const logged = await repo.messages.create({
      instance_id: instance.id,
      direction: 'out',
      from_number: from,
      to_number: to,
      type,
      content,
      status: 'failed',
      // Nunca null: sem código do provider, grava o `kind` — o histórico
      // sempre diz ALGUMA coisa sobre o motivo.
      error_code: cls.raw_code ?? cls.kind,
      error_message: cls.message,
      wa_message_id: null,
      campaign_id: campaignId,
    });
    throw new SendFailedError(cls.raw_code ?? cls.kind, cls.message, 502, logged.id);
  }
}
