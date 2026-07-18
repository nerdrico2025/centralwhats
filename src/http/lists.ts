import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const createSchema = z.object({ name: z.string().min(1) });
const contactsSchema = z.object({ contactIds: z.array(z.string().min(1)).min(1) });

/** Rotas de Listas de contato, escopadas por instance_id. */
export function createListsRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.lists.list(inst.id));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      res.status(201).json(await repo.lists.create({ instance_id: inst.id, name: parsed.data.name }));
    }),
  );

  router.delete(
    '/:listId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      await repo.lists.delete(inst.id, req.params.listId);
      res.sendStatus(204);
    }),
  );

  router.get(
    '/:listId/contacts',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.lists.listContacts(inst.id, req.params.listId));
    }),
  );

  router.post(
    '/:listId/contacts',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = contactsSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      await repo.lists.addContacts(inst.id, req.params.listId, parsed.data.contactIds);
      res.json({ ok: true, added: parsed.data.contactIds.length });
    }),
  );

  router.post(
    '/:listId/contacts/remove',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = contactsSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      await repo.lists.removeContacts(inst.id, req.params.listId, parsed.data.contactIds);
      res.json({ ok: true, removed: parsed.data.contactIds.length });
    }),
  );

  return router;
}
