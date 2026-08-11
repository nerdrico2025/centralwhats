import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const createSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1).nullable().optional(),
});
const massSchema = z.object({ contactIds: z.array(z.string().min(1)).min(1) });

/**
 * Rotas de Tags, escopadas por instance_id. Inclui APLICAÇÃO EM MASSA
 * (aplicar/remover a um conjunto de contatos numa operação). O repo ignora
 * contatos/tag de outra instância (escopo garantido na camada de dados).
 */
export function createTagsRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.tags.list(inst.id));
    }),
  );

  // Tags de TODOS os contatos da instância, agrupadas por contact_id. Serve a
  // lista de contatos da UI sem um request por linha.
  // Declarada antes de '/:tagId/...' não conflita (path fixo distinto).
  router.get(
    '/by-contact',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.tags.listGroupedByContact(inst.id));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const tag = await repo.tags.create({
        instance_id: inst.id,
        name: parsed.data.name,
        color: parsed.data.color ?? null,
      });
      res.status(201).json(tag);
    }),
  );

  router.delete(
    '/:tagId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      await repo.tags.delete(inst.id, req.params.tagId);
      res.sendStatus(204);
    }),
  );

  // Aplicação em massa (aplicar). Um só contato = lista de 1.
  router.post(
    '/:tagId/apply',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = massSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      await repo.tags.applyToContacts(inst.id, req.params.tagId, parsed.data.contactIds);
      res.json({ ok: true, applied: parsed.data.contactIds.length });
    }),
  );

  // Remoção em massa.
  router.post(
    '/:tagId/remove',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = massSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      await repo.tags.removeFromContacts(inst.id, req.params.tagId, parsed.data.contactIds);
      res.json({ ok: true, removed: parsed.data.contactIds.length });
    }),
  );

  return router;
}
