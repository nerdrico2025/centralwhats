import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import {
  sendViaProvider,
  SendFailedError,
  type MessagingDeps,
  type SendInput,
} from '../domain/messaging';
import { UnsupportedByProviderError } from '../providers/errors';
import { TemplateResolutionError } from '../domain/templates';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const mediaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document']),
  url: z.string().url().optional(),
  mediaId: z.string().min(1).optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const buttonSchema = z.object({ id: z.string().min(1), title: z.string().min(1).max(20) });
const listRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
const listSectionSchema = z.object({
  title: z.string().optional(),
  rows: z.array(listRowSchema).min(1),
});

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), to: z.string().min(1), text: z.string().min(1) }),
  z.object({ type: z.literal('media'), to: z.string().min(1), media: mediaSchema }),
  z.object({
    type: z.literal('template'),
    to: z.string().min(1),
    // language é OPCIONAL: se omitido, resolvemos pelo template sincronizado
    // (fonte da verdade da Meta). Nunca há default pt_BR.
    template: z.object({ name: z.string().min(1), language: z.string().min(2).optional() }),
    vars: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal('buttons'),
    to: z.string().min(1),
    body: z.string().min(1),
    buttons: z.array(buttonSchema).min(1).max(3),
  }),
  z.object({
    type: z.literal('list'),
    to: z.string().min(1),
    body: z.string().min(1),
    buttonText: z.string().min(1),
    sections: z.array(listSectionSchema).min(1),
  }),
  z.object({
    type: z.literal('reaction'),
    to: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1),
  }),
  z.object({
    type: z.literal('cta_url'),
    to: z.string().min(1),
    body: z.string().min(1),
    buttonText: z.string().min(1),
    url: z.string().url(),
  }),
]);

/**
 * Rota de envio avulso: POST /instances/:id/messages (todos os tipos).
 * O handler resolve a instância e delega a sendViaProvider (que usa provider.*).
 * NUNCA chama a Graph API direto.
 */
export function createMessagesRouter(repo: Repo, deps: MessagingDeps = {}): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);

      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      }

      try {
        const { message, result } = await sendViaProvider(
          repo,
          inst,
          parsed.data as SendInput,
          deps,
        );
        res.status(201).json({
          id: message.id,
          wa_message_id: result.waMessageId,
          status: message.status,
          type: message.type,
        });
      } catch (err) {
        if (err instanceof UnsupportedByProviderError) {
          throw new HttpError(422, err.message);
        }
        if (err instanceof TemplateResolutionError) {
          throw new HttpError(400, err.message);
        }
        if (err instanceof SendFailedError) {
          // Erro da Meta já gravado em messages; devolve estruturado ao client.
          throw new HttpError(502, 'Falha no envio pela Meta', {
            code: err.code,
            message: err.message,
            logged_message_id: err.loggedMessageId,
          });
        }
        throw err;
      }
    }),
  );

  return router;
}
