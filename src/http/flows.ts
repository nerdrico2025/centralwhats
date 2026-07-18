import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { validateFlowDefinition } from '../domain/flowValidation';
import type { FlowDefinition } from '../domain/flowEngine';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const nodeSchema = z
  .object({ id: z.string().min(1), type: z.string().min(1) })
  .passthrough(); // data/x/y livres — o engine só usa id/type/data
const edgeSchema = z
  .object({ source: z.string().min(1), target: z.string().min(1) })
  .passthrough();

const writeSchema = z.object({
  name: z.string().min(1),
  trigger_keywords: z.array(z.string()).default([]),
  nodes: z.array(nodeSchema).default([]),
  edges: z.array(edgeSchema).default([]),
  active: z.boolean().default(false),
});

/**
 * Rotas de Fluxos (builder, P4.5), escopadas por instance_id.
 * Sem DELETE de fluxo: preferimos editar a apagar (lição 4). Toda escrita
 * retorna `warnings` da validação estrutural — nada é silencioso.
 */
export function createFlowsRouter(repo: Repo): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.flows.list(inst.id));
    }),
  );

  router.get(
    '/:flowId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const flow = await repo.flows.getById(inst.id, req.params.flowId);
      if (!flow) throw new HttpError(404, 'Fluxo não encontrado');
      res.json(flow);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = writeSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const d = parsed.data;
      const warnings = validateFlowDefinition({
        nodes: d.nodes,
        edges: d.edges,
      } as FlowDefinition);
      const flow = await repo.flows.create({
        instance_id: inst.id,
        name: d.name,
        trigger_keywords: d.trigger_keywords,
        nodes: d.nodes,
        edges: d.edges,
        active: d.active,
      });
      res.status(201).json({ flow, warnings });
    }),
  );

  router.patch(
    '/:flowId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = writeSchema.partial().safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const updated = await repo.flows.update(inst.id, req.params.flowId, parsed.data);
      if (!updated) throw new HttpError(404, 'Fluxo não encontrado');
      const warnings = validateFlowDefinition({
        nodes: updated.nodes,
        edges: updated.edges,
      } as FlowDefinition);
      res.json({ flow: updated, warnings });
    }),
  );

  // LIÇÃO 4: execuções ativas do fluxo — a UI avisa antes de apagar/editar nós.
  router.get(
    '/:flowId/executions/active',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const flow = await repo.flows.getById(inst.id, req.params.flowId);
      if (!flow) throw new HttpError(404, 'Fluxo não encontrado');
      const active = await repo.flowExecutions.listActiveByFlow(flow.id);
      const byNode: Record<string, number> = {};
      for (const e of active) {
        const k = e.current_node_id ?? '(sem nó)';
        byNode[k] = (byNode[k] ?? 0) + 1;
      }
      res.json({ total: active.length, by_node: byNode });
    }),
  );

  return router;
}
