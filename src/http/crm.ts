import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const upsertSchema = z.object({
  stage: z.string().min(1).nullable().optional(),
  score: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
  name: z.string().min(1).nullable().optional(),
});

/**
 * Rotas de CRM, escopadas por instance_id. Estágio configurável (string livre),
 * score, notas e campos customizados (json). Opera por contact_id.
 */
export function createCrmRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const stage = typeof req.query.stage === 'string' ? req.query.stage : undefined;
      res.json(await repo.crm.list(inst.id, { stage }));
    }),
  );

  router.get(
    '/:contactId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const crm = await repo.crm.getByContact(inst.id, req.params.contactId);
      if (!crm) throw new HttpError(404, 'Registro de CRM não encontrado');
      res.json(crm);
    }),
  );

  // Cria/atualiza o CRM de um contato (mover estágio, score, notas, campos).
  router.put(
    '/:contactId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      const contact = await repo.contacts.getById(inst.id, req.params.contactId);
      if (!contact) throw new HttpError(404, 'Contato não encontrado');

      const existing = await repo.crm.getByContact(inst.id, contact.id);
      const d = parsed.data;
      const saved = await repo.crm.upsert({
        instance_id: inst.id,
        contact_id: contact.id,
        phone: contact.phone,
        name: d.name ?? existing?.name ?? contact.name ?? null,
        stage: d.stage !== undefined ? d.stage : (existing?.stage ?? 'lead'),
        score: d.score !== undefined ? d.score : (existing?.score ?? 0),
        notes: d.notes !== undefined ? d.notes : (existing?.notes ?? null),
        custom_fields: d.custom_fields ?? existing?.custom_fields ?? {},
      });
      res.json(saved);
    }),
  );

  return router;
}
