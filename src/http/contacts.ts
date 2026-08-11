import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const upsertSchema = z.object({
  phone: z.string().min(1),
  name: z.string().min(1).nullable().optional(),
});
/** Edição manual do nome. `null`/vazio devolve o nome ao controle da Meta. */
const renameSchema = z.object({ name: z.string().nullable() });

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

  /**
   * PLANO B do nome (PRD §3.5): a Meta pode não compartilhar profile.name por
   * privacidade. Aqui o operador escreve o nome na mão — e a marca
   * `name_source='manual'` faz o webhook parar de sobrescrever essa correção.
   */
  router.patch(
    '/:contactId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = renameSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);

      // Limpar o nome devolve o contato à Meta: sem valor manual a defender,
      // o próximo profile.name volta a preencher normalmente.
      const name = parsed.data.name?.trim() || null;
      const updated = await repo.contacts.setName(
        inst.id,
        req.params.contactId,
        name,
        'manual',
      );
      if (!updated) throw new HttpError(404, 'Contato não encontrado');
      res.json(updated);
    }),
  );

  /**
   * Tags aplicadas ao contato. O repo já tinha listForContact (o motor de
   * fluxos usa), mas nada expunha por HTTP: dava para aplicar tag e nunca mais
   * ler quais o contato tem.
   */
  router.get(
    '/:contactId/tags',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const contact = await repo.contacts.getById(inst.id, req.params.contactId);
      if (!contact) throw new HttpError(404, 'Contato não encontrado');
      res.json(await repo.tags.listForContact(inst.id, contact.id));
    }),
  );

  return router;
}
