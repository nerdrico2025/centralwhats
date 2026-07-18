import { Router } from 'express';
import type { Repo } from '../repo';
import { asyncHandler, getAuth, requireInstance } from './util';

/** GET /instances/:id/dashboard — métricas agregadas (sem N+1). */
export function createDashboardRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const inst = await requireInstance(repo, req.params.id, auth.orgId);
      // Agregados cross-instância (ativas / por instância) escopados pela org.
      res.json(await repo.metrics.dashboard(inst.id, auth.orgId));
    }),
  );
  return router;
}
