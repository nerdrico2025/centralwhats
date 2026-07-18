import { Router } from 'express';
import { z } from 'zod';
import type { Repo } from '../repo';
import { countRecipients, resolveRecipients } from '../domain/campaigns';
import {
  startCampaign,
  processCampaignTick,
  pauseCampaign,
  DispatchError,
} from '../domain/dispatch';
import type { MessagingDeps } from '../domain/messaging';
import { asyncHandler, getAuth, HttpError, requireInstance } from './util';

const createSchema = z.object({
  name: z.string().min(1),
  template_id: z.string().min(1).nullable().optional(),
  list_ids: z.array(z.string().min(1)).default([]),
  variables: z.record(z.string()).default({}),
  interval_ms: z.number().int().positive().default(1000),
});

/**
 * Rotas de Campanhas (P3.1): criação e pré-visualização de destinatários.
 * NÃO dispara nada — o motor de disparo é o P3.2.
 */
export function createCampaignsRouter(repo: Repo, deps: MessagingDeps = {}): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      res.json(await repo.campaigns.list(inst.id));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Dados inválidos', parsed.error.issues);
      const d = parsed.data;

      // Valida o template escolhido (idioma vem dele — fonte da verdade).
      if (d.template_id) {
        const tpl = await repo.templates.getById(inst.id, d.template_id);
        if (!tpl) throw new HttpError(400, 'Template não encontrado (rode o sync primeiro)');
      }

      const total = await countRecipients(repo, inst.id, d.list_ids);
      const campaign = await repo.campaigns.create({
        instance_id: inst.id,
        name: d.name,
        template_id: d.template_id ?? null,
        total_recipients: total,
        interval_ms: d.interval_ms,
        status: 'draft',
        config: { list_ids: d.list_ids, variables: d.variables },
      });
      res.status(201).json(campaign);
    }),
  );

  router.get(
    '/:campaignId',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const campaign = await repo.campaigns.getById(inst.id, req.params.campaignId);
      if (!campaign) throw new HttpError(404, 'Campanha não encontrada');
      res.json(campaign);
    }),
  );

  // Pré-visualização dos destinatários resolvidos (com variáveis). Sem envio.
  router.get(
    '/:campaignId/recipients',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const campaign = await repo.campaigns.getById(inst.id, req.params.campaignId);
      if (!campaign) throw new HttpError(404, 'Campanha não encontrada');

      const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const { total, recipients } = await resolveRecipients(repo, inst, campaign.config, {
        limit,
        offset,
      });

      const tpl = campaign.template_id
        ? await repo.templates.getById(inst.id, campaign.template_id)
        : null;
      res.json({
        total,
        template: tpl ? { name: tpl.name, language: tpl.language } : null,
        recipients,
      });
    }),
  );

  // === Disparo (P3.2) ===
  // Inicia/retoma o disparo (materializa a fila e marca running).
  router.post(
    '/:campaignId/start',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      try {
        res.json(await startCampaign(repo, inst, req.params.campaignId, deps));
      } catch (err) {
        if (err instanceof DispatchError) throw new HttpError(400, err.message);
        throw err;
      }
    }),
  );

  // Processa UM lote e reagenda (a UI chama em polling enquanto running).
  router.post(
    '/:campaignId/tick',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      try {
        res.json(await processCampaignTick(repo, inst, req.params.campaignId, deps));
      } catch (err) {
        if (err instanceof DispatchError) throw new HttpError(400, err.message);
        throw err;
      }
    }),
  );

  // Pausa o disparo.
  router.post(
    '/:campaignId/pause',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      try {
        res.json(await pauseCampaign(repo, inst, req.params.campaignId));
      } catch (err) {
        if (err instanceof DispatchError) throw new HttpError(400, err.message);
        throw err;
      }
    }),
  );

  // Auditoria: envios por status (ex.: ?status=failed → falhas com motivo).
  router.get(
    '/:campaignId/sends',
    asyncHandler(async (req, res) => {
      const inst = await requireInstance(repo, req.params.id, getAuth(req).orgId);
      const campaign = await repo.campaigns.getById(inst.id, req.params.campaignId);
      if (!campaign) throw new HttpError(404, 'Campanha não encontrada');
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const sends = status
        ? await repo.campaigns.listSendsByStatus(campaign.id, status)
        : await repo.campaigns.listSends(campaign.id);
      res.json(sends);
    }),
  );

  return router;
}
