import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const upsertSchema = z.object({
  phone: z.string().min(1),
  name: z.string().min(1).nullable().optional(),
});

/**
 * Rotas de Contatos, escopadas por instance_id. Telefone é normalizado pelo
 * repo (função única). Nome vem do profile.name (webhook) ou manual (aqui).
 */
export function createContactsRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      res.json(await repo.contacts.list(inst.id, { search }));
    }),
  );

  router.get(
    '/:contactId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const contact = await repo.contacts.getById(inst.id, req.params.contactId);
      if (!contact) throw new HttpError(404, 'Contato não encontrado');
      res.json(contact);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const contact = await repo.contacts.upsert({
        instance_id: inst.id,
        phone: parsed.data.phone,
        name: parsed.data.name ?? null,
        last_seen: null,
      });
      res.status(201).json(contact);
    }),
  );

  return router;
}
