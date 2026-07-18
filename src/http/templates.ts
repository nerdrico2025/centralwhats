import { Router } from 'express';
import type { Repo } from '../repo';
import { syncTemplates } from '../domain/templates';
import type { MetaTemplatesOptions } from '../providers/metaTemplates';
import { MetaApiError } from '../providers/errors';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

/**
 * Rotas de Templates:
 *  POST /instances/:id/templates/sync — sincroniza da Meta.
 *  GET  /instances/:id/templates       — lista os sincronizados.
 */
export function createTemplatesRouter(
  repo: Repo,
  deps: MetaTemplatesOptions = {},
): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.templates.list(inst.id));
    }),
  );

  router.post(
    '/sync',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      try {
        const result = await syncTemplates(repo, inst, deps);
        res.json({ synced: result.synced, templates: result.templates });
      } catch (err) {
        if (err instanceof MetaApiError) {
          throw new HttpError(502, 'Falha ao sincronizar templates da Meta', {
            code: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    }),
  );

  return router;
}
