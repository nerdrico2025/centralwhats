import { Router } from 'express';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, requireInstance } from './util';

/**
 * Rotas do Live Chat, escopadas por instance_id.
 *  GET  /conversations                 — lista de conversas (última msg + não-lidas)
 *  GET  /conversations/:phone/messages — thread paginada (limit/before)
 *  POST /conversations/:phone/read     — marca a conversa como lida
 *
 * Responder reutiliza POST /instances/:id/messages (P1.3) — nada de envio novo.
 * Atualização no front é por POLLING curto (sem WebSocket na camada web).
 */
export function createLiveChatRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.messages.listConversations(inst.id));
    }),
  );

  router.get(
    '/:phone/messages',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const msgs = await repo.messages.listByContact(inst.id, req.params.phone, { limit, before });
      res.json(msgs);
    }),
  );

  router.post(
    '/:phone/read',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      await repo.contacts.markRead(inst.id, req.params.phone, new Date().toISOString());
      res.json({ ok: true });
    }),
  );

  return router;
}
